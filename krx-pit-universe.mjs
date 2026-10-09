// Official KRX daily all-stock history source for point-in-time backtests.
// Credentials are read exclusively from KRX_AUTH_KEY. Never stored in Git.
// API service approval is required from https://openapi.krx.co.kr/
import {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const endpoints=Object.freeze({KOSPI:"stk_bydd_trd",KOSDAQ:"ksq_bydd_trd"});
const getNum=(value)=>Number(String(value??"").replaceAll(",","").trim());
const numberOk=(v)=>Number.isFinite(v)&&v>=0;
export function normalizeKrxMarketRows(response,{date,market,minCount=500}){
  const raw=response?.OutBlock_1??response?.output??null;
  if(!Array.isArray(raw))throw Error(`KRX_BAD_RESPONSE_${market}`);
  const errors=[],rows=[],codes=new Set();
  for(const a of raw){
    const code=String(a.ISU_CD??"").trim().replace(/^A(?=\d{6}$)/,"");
    const rowDate=String(a.BAS_DD??"");
    if(rowDate!==date){errors.push({reason:"DATE_MISMATCH",date:rowDate,code});continue;}
    if(!/^\d{6}$/.test(code)){errors.push({reason:"INVALID_SHORT_CODE",code});continue;}
    if(codes.has(code)){errors.push({reason:"DUPLICATE_CODE",code});continue;}
    codes.add(code);
    const open=getNum(a.TDD_OPNPRC),high=getNum(a.TDD_HGPRC),
      low=getNum(a.TDD_LWPRC),close=getNum(a.TDD_CLSPRC),
      volume=getNum(a.ACC_TRDVOL),value=getNum(a.ACC_TRDVAL),
      marketCap=getNum(a.MKTCAP),listedShares=getNum(a.LIST_SHRS);
    if(![open,high,low,close,volume,value,marketCap,listedShares].every(numberOk)||
       listedShares<=0||marketCap<=0){
      errors.push({reason:"INVALID_NUMERIC_FIELDS",code});continue;
    }
    const trading=open>0&&high>0&&low>0&&close>0;
    if(trading&&(high<Math.max(open,close,low)||low>Math.min(open,close,high))){
      errors.push({reason:"INVALID_OHLC",code});continue;
    }
    rows.push({date,market,code,name:String(a.ISU_NM??"").trim(),open,high,low,close,
      volume,tradingValue:value,marketCap,listedShares,
      canTrade:trading&&volume>0,
      dataSource:"KRX_OPEN_API_DAILY_TRADES"});
  }
  // Fail closed if even one row was malformed rather than quietly dropping it.
  if(errors.length || rows.length<minCount)
    throw Error(`KRX_COVERAGE_INVALID_${market}:valid=${rows.length},minimum=${minCount},errors=${errors.length},examples=${JSON.stringify(errors.slice(0,3))}`);
  return {
    schema:"krx-market-pit-v1",date,market,source:"KRX Open API",
    sourceEndpoint:`/svc/apis/sto/${endpoints[market]}`,
    rows
  };
}
export function validateHistoricalKrxCoverage(dateMarketSnapshots,requiredDates,{minCount=500}={}){
  const missing=[],invalid=[],present={KOSPI:0,KOSDAQ:0};
  for(const date of requiredDates)for(const market of Object.keys(endpoints)){
    const item=dateMarketSnapshots.get(`${date}|${market}`);
    if(!item){missing.push({date,market});continue;}
    if(item.schema!=="krx-market-pit-v1"||item.date!==date||item.market!==market||item.rows?.length<minCount)
      invalid.push({date,market,reason:"INSUFFICIENT_OR_UNTRUSTED_COVERAGE"});
    else present[market]++;
  }
  const ok=missing.length===0&&invalid.length===0;
  return {readyForPitRebuild:ok,requiredDays:requiredDates.length,expectedDailyFiles:requiredDates.length*2,
    validatedDailyFiles:present.KOSPI+present.KOSDAQ,missingDays:missing.length/2,missingFileCount:missing.length,
    invalidFileCount:invalid.length,missingExamples:missing.slice(0,6),invalidExamples:invalid.slice(0,6),
    note:ok?"Coverage gate passed; next check listing/delisting and external corporate-action events before backtesting":
      "Current fixed 200-stock experiment remains biased. Do not substitute its scores for a PIT full-market test."};
}
export function readValidatedKrxSnapshots(dir,dates=[],{minCount=500}={}){
  const out=new Map(),invalid=[];
  for(const date of dates)for(const market of Object.keys(endpoints)){
    const file=path.join(dir,date,`${market}.json`);
    if(!existsSync(file))continue;
    try {
      const saved=JSON.parse(readFileSync(file,"utf8"));
      if(saved.source!=="KRX Open API" || saved.schema!=="krx-market-pit-v1" || saved.date!==date || saved.market!==market){
        throw Error("UNTRUSTED_PROVENANCE");
      }
      const fakeResp={OutBlock_1:saved.rows.map(x=>({
        BAS_DD:x.date,ISU_CD:x.code,ISU_NM:x.name,TDD_OPNPRC:x.open,TDD_HGPRC:x.high,
        TDD_LWPRC:x.low,TDD_CLSPRC:x.close,ACC_TRDVOL:x.volume,
        ACC_TRDVAL:x.tradingValue,MKTCAP:x.marketCap,LIST_SHRS:x.listedShares
      }))};
      normalizeKrxMarketRows(fakeResp,{date,market,minCount});
      out.set(`${date}|${market}`,saved);
    }catch(e){invalid.push({date,market,reason:e.message});}
  }
  return {files:out,invalid};
}
export async function collectKrxDaily({date,rootDir,authKey,fetchImpl=fetch,minCount=500}){
  if(!/^20\d{6}$/.test(date))throw Error("KRX_DATE_INVALID");
  if(!authKey)throw Error("KRX_AUTH_KEY_NOT_CONFIGURED: approved KRX Open API key required");
  const written=[];
  for(const [market,endpoint] of Object.entries(endpoints)){
    const file=path.join(rootDir,date,`${market}.json`);
    if(existsSync(file)){
      const existing=JSON.parse(readFileSync(file,"utf8"));
      normalizeKrxMarketRows({OutBlock_1:existing.rows.map(x=>({
        BAS_DD:x.date,ISU_CD:x.code,ISU_NM:x.name,TDD_OPNPRC:x.open,TDD_HGPRC:x.high,
        TDD_LWPRC:x.low,TDD_CLSPRC:x.close,ACC_TRDVOL:x.volume,
        ACC_TRDVAL:x.tradingValue,MKTCAP:x.marketCap,LIST_SHRS:x.listedShares
      }))},{date,market,minCount});
      written.push({market,file,skippedCached:true,count:existing.rows.length});
      continue;
    }
    const url=`https://data-dbg.krx.co.kr/svc/apis/sto/${endpoint}?basDd=${date}`;
    const res=await fetchImpl(url,{headers:{AUTH_KEY:authKey,Accept:"application/json"},signal:AbortSignal.timeout(20000)});
    if(!res.ok)throw Error(`KRX_HTTP_${res.status}_${market}`);
    const normalized=normalizeKrxMarketRows(await res.json(),{date,market,minCount});
    mkdirSync(path.dirname(file),{recursive:true});
    const temporary=`${file}.tmp`;
    writeFileSync(temporary,JSON.stringify({...normalized,retrievedAt:new Date().toISOString()}),"utf8");
    renameSync(temporary,file);
    written.push({market,file,skippedCached:false,count:normalized.rows.length});
  }
  return {date,markets:written,complete:written.length===2};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const date=process.argv[2],dir=process.argv[3]||path.resolve("data-integrity/pit-krx");
  collectKrxDaily({date,rootDir:dir,authKey:process.env.KRX_AUTH_KEY}).then(x=>
    console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(e.message);process.exitCode=1});
}
