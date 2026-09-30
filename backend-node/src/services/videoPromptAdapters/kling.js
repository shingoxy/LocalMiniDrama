module.exports = {
  version: 'legacy-v1', supports: model => /kling/i.test(model),
  adapt: (intent, prompt) => prompt || intent.original_prompt,
};
