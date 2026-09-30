import request from '@/utils/request'
import { ElMessage, ElMessageBox } from 'element-plus'
import { hybridVideoAPI } from './hybridVideo'
import { costReportText } from '@/utils/videoCostReport'

export const videosAPI = {
  list(params) {
    return request.get('/videos', { params: params || {} })
  },
  /** 创建单条分镜视频生成任务，body: { drama_id, storyboard_id, prompt, image_url?, model?, ... } */
  async confirm(requests) {
    const quote = await hybridVideoAPI.quote(requests)
    if (quote.requires_cloud_confirmation) {
      await ElMessageBox.confirm(costReportText(quote), '云视频费用确认', {
        confirmButtonText: quote.incomplete ? '已了解未知费用，确认调用云模型' : '确认费用并生成',
        cancelButtonText: '取消', type: 'warning', customClass: 'video-cost-confirm',
      })
    } else {
      const unknownTime=quote.groups.some(g=>g.unknown_compute)
      const minutes=quote.groups.reduce((n,g)=>n+g.compute_seconds,0)/60
      ElMessage({message:`本地生成：${quote.shots.length} Shots · API ¥0 · 预计耗时 ${unknownTime ? '待本机实测' : minutes.toFixed(1)+' min'}`,duration:8000,showClose:true})
    }
    return quote
  },
  async create(body, confirmedQuote = null) {
    const quote = confirmedQuote || await this.confirm([body])
    return request.post('/videos', { ...body, quote_token: quote.token, cloud_confirmed: true })
  },
  /** 失败后复用已存上游 task 继续轮询，返回 video_generations 记录（含 task_id） */
  resumePoll(id) {
    return request.post(`/videos/${id}/resume-poll`)
  },
}
