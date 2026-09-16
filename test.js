// node test.js
const assert=require('assert');
const {ymd,streaks}=require('./streak.js');
const S=(...d)=>new Set(d);
const T=new Date(2026,2,10); // 2026-03-10

assert.deepStrictEqual(streaks(S(),T),{cur:0,best:0});
assert.deepStrictEqual(streaks(S('2026-03-10'),T),{cur:1,best:1});
// 今天沒打卡 → 從昨天起算，連續不中斷
assert.deepStrictEqual(streaks(S('2026-03-08','2026-03-09'),T),{cur:2,best:2});
// 前天斷掉 → 今天與昨天都沒打卡，cur 歸零
assert.deepStrictEqual(streaks(S('2026-03-01','2026-03-02','2026-03-03'),T),{cur:0,best:3});
// 跨月連續
assert.deepStrictEqual(streaks(S('2026-02-28','2026-03-01'),T),{cur:0,best:2});
// 最佳紀錄來自過去，目前另一段
assert.deepStrictEqual(streaks(S('2026-01-01','2026-01-02','2026-01-03','2026-01-04','2026-03-09','2026-03-10'),T),{cur:2,best:4});
// 日期字串用本地時區，不受 UTC 位移影響
assert.strictEqual(ymd(new Date(2026,0,1)),'2026-01-01');
console.log('ok');
