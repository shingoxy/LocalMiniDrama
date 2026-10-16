/** 本地视频可能排队数小时；长任务降低查询频率，完成/失败由后台判定。 */
export function getTaskPollInterval(resourceType, elapsedMs) {
  return resourceType === 'sb_video' && elapsedMs >= 60_000 ? 10_000 : 2000
}
