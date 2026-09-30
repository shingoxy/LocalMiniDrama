export function money(value, currency = 'CNY') {
  return value == null ? '未知' : `${currency === 'CNY' ? '¥' : currency + ' '}${Number(value).toFixed(2)}`
}
export function costReportText(report) {
  const lines = report.groups.map(g => `${g.label}: ${g.shots} shots / ${g.duration} sec / API ${g.unknown_prices ? '未知（尚未填写价格）' : money(g.api_cost,g.currency)}${g.local ? ` / 本机耗时 ${g.unknown_compute ? '待本机历史数据' : (g.compute_seconds/60).toFixed(1)+' min'}` : ''}`)
  for (const [currency,t] of Object.entries(report.totals)) {
    lines.push(`${currency}: Variable API ${money(t.variable_api,currency)}${t.unknown_shots ? ' + 未知费用' : ''} | Subscription Allocation ${money(t.subscription_allocation,currency)} | Overage ${money(t.subscription_overage,currency)} | Local Compute ${money(t.local_compute || 0,currency)} | Electricity ${money(t.electricity,currency)}`)
    lines.push(`Base Estimated ${money(t.base_total,currency)} | Risk-adjusted Budget ${money(t.risk_adjusted_budget,currency)} (${report.retry_multiplier}x)`)
  }
  if (report.incomplete) lines.push('存在未定价格或未定本机耗时，以上金额只是已知部分。')
  lines.push(...report.warnings)
  return lines.join('\n\n')
}
