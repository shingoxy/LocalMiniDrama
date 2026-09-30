import test from 'node:test'
import assert from 'node:assert/strict'
import { money, costReportText } from '../src/utils/videoCostReport.js'
test('unknown monetary values are distinct from zero',()=>{
  assert.equal(money(null),'未知');assert.equal(money(0),'¥0.00');assert.equal(money(3,'USD'),'USD 3.00')
})
test('cost confirmation reports unknown prices and measured-time absence',()=>{
  const text=costReportText({groups:[{label:'Local H3',shots:2,duration:10,api_cost:0,currency:'CNY',local:true,unknown_compute:true},
    {label:'Kling',shots:1,duration:5,unknown_prices:1,currency:'CNY'}],totals:{CNY:{variable_api:0,subscription_allocation:25,subscription_overage:0,electricity:0,unknown_shots:1,base_total:25,risk_adjusted_budget:25}},warnings:['Quota unknown'],incomplete:true,retry_multiplier:1.5})
  assert.match(text,/待本机历史数据/);assert.match(text,/尚未填写价格/);assert.match(text,/已知部分/);assert.match(text,/Subscription Allocation ¥25.00/)
})
test('CNY and USD estimates remain separate without an invented exchange rate',()=>{
  const base={variable_api:3,subscription_allocation:0,subscription_overage:0,electricity:0,unknown_shots:0,base_total:3,risk_adjusted_budget:3.6}
  const text=costReportText({groups:[],totals:{CNY:base,USD:base},warnings:[],retry_multiplier:1.2})
  assert.match(text,/CNY: Variable API ¥3.00/);assert.match(text,/USD: Variable API USD 3.00/)
})
