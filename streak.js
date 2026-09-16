// 連續天數計算。index.html 與 test.js 共用（純函式，不碰 DOM）。
function ymd(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function parseYmd(s){const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d)}

// cur: 從今天往回數；今天還沒打卡就從昨天起算（當天尚未結束，不算中斷）
// best: 掃過所有紀錄的最長連續段
function streaks(done, today = new Date()){
  let cur=0, c=new Date(today);
  if(!done.has(ymd(c))) c.setDate(c.getDate()-1);
  while(done.has(ymd(c))){cur++;c.setDate(c.getDate()-1)}
  let best=0, run=0, prev=null;
  for(const s of [...done].sort()){
    run = (prev && Math.round((parseYmd(s)-parseYmd(prev))/864e5)===1) ? run+1 : 1;
    if(run>best) best=run;
    prev=s;
  }
  return {cur,best};
}
if (typeof module !== 'undefined') module.exports = {ymd, parseYmd, streaks};
