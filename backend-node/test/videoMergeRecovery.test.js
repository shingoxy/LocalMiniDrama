const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function fixture(t, metadata = {}) {
  const db = new Database(':memory:');
  require('../src/db/migrate').runMigrationsAndEnsure(db);
  db.prepare('INSERT INTO dramas (id, title, metadata) VALUES (1, ?, ?)').run('Mock', JSON.stringify(metadata));
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number) VALUES (1, 1, 1)').run();
  db.prepare('INSERT INTO storyboards (id, episode_id, storyboard_number, duration) VALUES (1, 1, 1, 2)').run();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drama-merge-test-'));
  const input = path.join(root, 'input.mp4');
  fs.writeFileSync(input, 'mock video with audio');
  t.after(() => {
    db.close();
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'drama-merge-test-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(require('../src/config'), 'loadConfig', () => ({ storage: { local_path: root }, style: {} }));
  const ffmpeg = require('../src/utils/ffmpegPath');
  t.mock.method(ffmpeg, 'getFfmpegPath', () => 'mock-ffmpeg');
  t.mock.method(ffmpeg, 'getFfprobePath', () => 'mock-ffprobe');
  t.mock.method(ffmpeg, 'hasLocalFfmpeg', () => true);
  const calls = [];
  t.mock.method(require('node:child_process'), 'spawnSync', (bin, args) => {
    calls.push({ bin, args });
    if (bin === 'mock-ffprobe') return { status: 0, stdout: args.includes('a') ? '1\n' : '2\n' };
    fs.writeFileSync(args.at(-1), 'mock output');
    return { status: 0, stdout: '', stderr: '' };
  });
  delete require.cache[require.resolve('../src/services/mergedEpisodePostProcess')];
  delete require.cache[require.resolve('../src/services/videoMergeService')];
  const post = require('../src/services/mergedEpisodePostProcess');
  const merges = require('../src/services/videoMergeService');
  const scenes = [{ scene_id: 1, video_url: input, duration: 2 }];
  const opts = { mergedAbsPath: input, storageRoot: root, scenes, episodeId: 1, dramaId: 1,
    mergeOpts: { burn_dialogue_audio: true, burn_narration_subtitles: true } };
  return { db, root, input, calls, post, merges, scenes, opts };
}

test('Checked dubbing/narration with no assets leaves source audio untouched and makes no TTS/FFmpeg calls', async (t) => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  const result = await f.post.runMergedEpisodePostProcess(f.db, quiet, f.opts);
  assert.equal(result.error, 'NO_POST_OPTS');
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(f.input, 'utf8'), 'mock video with audio');
});

test('Watermark with empty dubbing retains original audio instead of mapping a silent replacement', async (t) => {
  const f = fixture(t);
  f.opts.mergeOpts.watermark_text = 'Episode 1';
  const result = await f.post.runMergedEpisodePostProcess(f.db, quiet, f.opts);
  assert.equal(result.ok, true);
  const mux = f.calls.find((call) => call.args.includes('-filter_complex'));
  assert.ok(mux.args.includes('0:a'));
  assert.equal(mux.args.includes('1:a'), false);
  assert.equal(f.calls.some((call) => call.args.includes('anullsrc=r=44100:cl=mono')), false);
});

test('Existing dubbing is mixed with source sound; missing segments cannot erase source audio', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'dialogue.mp3'), 'mock dialogue');
  f.db.prepare("UPDATE storyboards SET dialogue = 'Hello', audio_local_path = 'dialogue.mp3' WHERE id = 1").run();
  const result = await f.post.runMergedEpisodePostProcess(f.db, quiet, f.opts);
  assert.equal(result.ok, true);
  const mux = f.calls.find((call) => call.args.includes('libx264'));
  const filter = mux.args[mux.args.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[0:a\]\[1:a\]amix/);
  assert.ok(mux.args.includes('[aout]'));
});

test('English narration drives both SRT and TTS while stored Chinese narration stays unchanged', async (t) => {
  const f = fixture(t, { media_language: 'en', script_language: 'zh' });
  f.db.prepare("UPDATE storyboards SET narration = '他已经失踪三周了。' WHERE id = 1").run();
  t.mock.method(require('../src/services/aiClient'), 'generateText', async () => '{"watermark":"","narration_0":"He has been missing for three weeks."}');
  const tts = t.mock.method(require('../src/services/ttsService'), 'synthesize', async (db, log, opts) => {
    assert.equal(opts.text, 'He has been missing for three weeks.');
    fs.writeFileSync(path.join(f.root, 'narration.mp3'), 'mock narration');
    return { local_path: 'narration.mp3' };
  });
  const result = await f.post.runMergedEpisodePostProcess(f.db, quiet, f.opts);
  assert.equal(result.ok, true);
  assert.equal(tts.mock.callCount(), 1);
  const srt = fs.readFileSync(path.join(f.root, 'input_narration.srt'), 'utf8');
  assert.match(srt, /He has been missing/);
  assert.equal(/\p{Script=Han}/u.test(srt), false);
  assert.equal(f.db.prepare('SELECT narration FROM storyboards WHERE id = 1').get().narration, '他已经失踪三周了。');
});

test('Interrupted local merge resumes a saved concat output and completes both merge and task', async (t) => {
  const f = fixture(t);
  const created = f.merges.create(f.db, quiet, { episode_id: 1, drama_id: 1, scenes: f.scenes, merge_options: f.opts.mergeOpts });
  f.db.prepare("UPDATE video_merges SET status = 'processing', merged_url = 'input.mp4' WHERE id = ?").run(created.merge_id);
  const tasks = require('../src/services/taskService');
  tasks.updateTaskStatus(f.db, created.task_id, 'processing', 70, 'concat saved');
  const ids = f.merges.resumeProcessingVideoMerges(f.db, quiet, 'http://localhost/static');
  assert.deepEqual(ids, [created.task_id]);
  assert.equal(tasks.failOrphanedAsyncTasksOnStartup(f.db, quiet, ids), 0);
  for (let i = 0; i < 20 && tasks.getTask(f.db, created.task_id).status !== 'completed'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tasks.getTask(f.db, created.task_id).status, 'completed');
  assert.equal(f.merges.getById(f.db, created.merge_id).merged_url, 'input.mp4');
  assert.equal(f.calls.some((call) => call.args.includes('concat')), false);
});

test('Post-processing errors mark merge and task failed instead of completing a fallback silently', async (t) => {
  const f = fixture(t);
  const created = f.merges.create(f.db, quiet, { episode_id: 1, drama_id: 1, scenes: f.scenes, merge_options: f.opts.mergeOpts });
  t.mock.method(f.post, 'runMergedEpisodePostProcess', async () => ({ ok: false, error: 'mock subtitle error' }));
  await f.merges.processVideoMerge(f.db, quiet, created.merge_id, '');
  assert.equal(f.merges.getById(f.db, created.merge_id).status, 'failed');
  assert.equal(require('../src/services/taskService').getTask(f.db, created.task_id).error, 'mock subtitle error');
});

test('Cancelled merges are not resumed', (t) => {
  const f = fixture(t);
  const created = f.merges.create(f.db, quiet, { episode_id: 1, drama_id: 1, scenes: f.scenes });
  require('../src/services/taskService').cancelTask(f.db, quiet, created.task_id);
  assert.deepEqual(f.merges.resumeProcessingVideoMerges(f.db, quiet, ''), []);
  assert.equal(f.merges.getById(f.db, created.merge_id).status, 'failed');
  assert.equal(f.merges.getById(f.db, created.merge_id).error_msg, '用户已取消');
});
