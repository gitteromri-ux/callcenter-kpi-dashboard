// ═══════════════════════════════════════════════════════════════════════════════
// DATE FILTER ENGINE — Recomputes all dashboard data from RAW_FILTER_DATA
// ═══════════════════════════════════════════════════════════════════════════════

const FilterEngine = (function(){
  const R = RAW_FILTER_DATA;
  const FULL = DASHBOARD_DATA;
  // dmc record indices: [dateIdx, mediaIdx, campIdx, leads, contacted, acq, orders, revenue, mcost, impressions]
  const DI=0, MI=1, CI=2, LI=3, CTI=4, AI=5, OI=6, RI=7, MCI=8, IMPI=9;

  let _startIdx = 0;
  let _endIdx = R.dates.length - 1;
  let _isFiltered = false;
  let _chartInstances = {};  // Store chart instances for destruction/rebuild

  function isFiltered(){ return _isFiltered; }
  function getDateRange(){ return { start: R.dates[_startIdx], end: R.dates[_endIdx] }; }

  // ── Core: filter raw records by date range ──────────────────────────────────
  function filteredRecords(){
    return R.dmc.filter(r => r[DI] >= _startIdx && r[DI] <= _endIdx);
  }

  function filteredDates(){
    return R.dates.filter((_,i) => i >= _startIdx && i <= _endIdx);
  }

  function filteredScatter(){
    const dates = new Set(filteredDates());
    return FULL.scatterData.filter(d => dates.has(d.date));
  }

  // ── Aggregation helpers ─────────────────────────────────────────────────────
  function sum(arr, idx){ let s=0; for(const r of arr) s+=r[idx]; return s; }

  function buildDayAgg(recs){
    // Group by dateIdx → day-level aggregation
    const byDate = {};
    for(const r of recs){
      const di = r[DI];
      if(!byDate[di]) byDate[di] = {leads:0,contacted:0,acq:0,orders:0,rev:0,cost:0,imp:0,sov:0};
      const d = byDate[di];
      d.leads += r[LI]; d.contacted += r[CTI]; d.acq += r[AI]; d.orders += r[OI];
      d.rev += r[RI]; d.cost += r[MCI]; d.imp += r[IMPI];
    }
    // Add shift and compute ratios
    const days = [];
    for(const [di, d] of Object.entries(byDate)){
      const shift = R.shifts[di] || 0;
      const date = R.dates[+di];
      const dow = new Date(date).getDay(); // 0=Sun
      const jsDay = new Date(date).getDay();
      const pyDow = jsDay===0?6:jsDay-1; // 0=Mon
      const isWeekend = pyDow >= 5;
      days.push({
        dateIdx: +di, date, shift,
        leads: d.leads, contacted: d.contacted, acq: d.acq, orders: d.orders,
        rev: d.rev, cost: d.cost, imp: d.imp,
        contactedRatio: d.leads>0 ? d.contacted/d.leads : 0,
        leadsPerShift: shift>0 ? d.leads/shift : 0,
        revenuePerLead: d.leads>0 ? d.rev/d.leads : 0,
        revenuePerShift: shift>0 ? d.rev/shift : 0,
        isWeekend,
        pyDow,
        dayName: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][pyDow],
        roi: d.cost>0 ? d.rev/d.cost : null,
      });
    }
    days.sort((a,b) => a.dateIdx - b.dateIdx);
    return days;
  }

  // ── Rebuild KPIs from filtered data ─────────────────────────────────────────
  function computeKPIs(recs, days){
    const totalLeads = sum(recs,LI), totalAcq = sum(recs,AI), totalOrders = sum(recs,OI);
    const totalRev = sum(recs,RI), totalCost = sum(recs,MCI);
    const n = days.length;

    // Revenue optimal zone: IQR of L/S across top-25% revenue days
    const nRevTop = Math.max(1, Math.floor(n*0.25));
    const topRevDays = [...days].sort((a,b)=>b.rev-a.rev).slice(0,nRevTop);
    const topRevLS = topRevDays.map(d=>d.leadsPerShift).sort((a,b)=>a-b);
    const q25 = percentile(topRevLS, 25), q75 = percentile(topRevLS, 75);

    // Top 4% by acq for acq optimal
    const nOpt = Math.max(1, Math.floor(n*0.04));
    const topAcqDays = [...days].sort((a,b)=>b.acq-a.acq).slice(0,nOpt);
    const topLS = topAcqDays.map(d=>d.leadsPerShift).sort((a,b)=>a-b);
    const acqQ1 = percentile(topLS,25), acqQ3 = percentile(topLS,75);

    const revOptDays = days.filter(d=>d.leadsPerShift>=q25 && d.leadsPerShift<=q75);
    const acqOptDays = days.filter(d=>d.leadsPerShift>=acqQ1 && d.leadsPerShift<=acqQ3 &&
      d.contactedRatio >= (topAcqDays.length>0 ? mean(topAcqDays.map(x=>x.contactedRatio))*0.9 : 0.45));

    const wd = days.filter(d=>!d.isWeekend), we = days.filter(d=>d.isWeekend);

    return {
      totalDays: n, totalRevenue: totalRev, avgDailyRevenue: n>0?totalRev/n:0,
      revenuePerLead: totalLeads>0?totalRev/totalLeads:0,
      revenuePerAcq: totalAcq>0?totalRev/totalAcq:0,
      totalAcquisitions: totalAcq, totalOrders, totalLeads,
      avgDailyLeads: n>0?totalLeads/n:0, avgDailyShift: n>0?mean(days.map(d=>d.shift)):0,
      avgContactedRatio: n>0?mean(days.map(d=>d.contactedRatio)):0,
      avgLeadsPerShift: n>0?mean(days.map(d=>d.leadsPerShift)):0,
      avgDailyAcq: n>0?totalAcq/n:0,
      revOptDays: revOptDays.length, revOptQ1: q25, revOptQ3: q75,
      revOptAvgRevenue: revOptDays.length>0?mean(revOptDays.map(d=>d.rev)):0,
      revOptAvgLeads: revOptDays.length>0?mean(revOptDays.map(d=>d.leads)):0,
      revOptAvgShift: revOptDays.length>0?mean(revOptDays.map(d=>d.shift)):0,
      revOptAvgLS: revOptDays.length>0?mean(revOptDays.map(d=>d.leadsPerShift)):0,
      revOptLeadsQ1: revOptDays.length>0?percentile(revOptDays.map(d=>d.leads).sort((a,b)=>a-b),25):0,
      revOptLeadsQ3: revOptDays.length>0?percentile(revOptDays.map(d=>d.leads).sort((a,b)=>a-b),75):0,
      acqOptDays: acqOptDays.length, acqOptQ1LS: acqQ1, acqOptQ3LS: acqQ3,
      acqOptAvgAcq: acqOptDays.length>0?mean(acqOptDays.map(d=>d.acq)):0,
      acqOptAvgLS: acqOptDays.length>0?mean(acqOptDays.map(d=>d.leadsPerShift)):0,
      acqOptQ1Leads: acqOptDays.length>0?percentile(acqOptDays.map(d=>d.leads).sort((a,b)=>a-b),25):0,
      acqOptQ3Leads: acqOptDays.length>0?percentile(acqOptDays.map(d=>d.leads).sort((a,b)=>a-b),75):0,
      acqOptQ1Shift: acqOptDays.length>0?percentile(acqOptDays.map(d=>d.shift).sort((a,b)=>a-b),25):0,
      acqOptQ3Shift: acqOptDays.length>0?percentile(acqOptDays.map(d=>d.shift).sort((a,b)=>a-b),75):0,
      acqOptAvgShift: acqOptDays.length>0?mean(acqOptDays.map(d=>d.shift)):0,
      acqOptAvgLeads: acqOptDays.length>0?mean(acqOptDays.map(d=>d.leads)):0,
      acqOptAvgSOV: acqOptDays.length>0?mean(acqOptDays.map(d=>d.rev)):0,
      acqOptContThr: topAcqDays.length>0?mean(topAcqDays.map(x=>x.contactedRatio))*0.9:0.45,
      weekdayOptDays: revOptDays.filter(d=>!d.isWeekend).length,
      weekendOptDays: revOptDays.filter(d=>d.isWeekend).length,
      weekdayDays: wd.length, weekendDays: we.length,
      weekdayAvgAcq: wd.length>0?mean(wd.map(d=>d.acq)):0,
      weekendAvgAcq: we.length>0?mean(we.map(d=>d.acq)):0,
      weekdayAvgRevenue: wd.length>0?mean(wd.map(d=>d.rev)):0,
      weekendAvgRevenue: we.length>0?mean(we.map(d=>d.rev)):0,
      weekdayAvgShift: wd.length>0?mean(wd.map(d=>d.shift)):0,
      weekendAvgShift: we.length>0?mean(we.map(d=>d.shift)):0,
      weekdayAvgContactedRatio: wd.length>0?mean(wd.map(d=>d.contactedRatio)):0,
      weekendAvgContactedRatio: we.length>0?mean(we.map(d=>d.contactedRatio)):0,
      weekdayAvgLeadsPerShift: wd.length>0?mean(wd.map(d=>d.leadsPerShift)):0,
      weekendAvgLeadsPerShift: we.length>0?mean(we.map(d=>d.leadsPerShift)):0,
      avgRevenuePerLead: totalLeads>0?totalRev/totalLeads:0,
      avgRevenuePerAcq: totalAcq>0?totalRev/totalAcq:0,
      corrLSRatioRev: correlation(days.map(d=>d.leadsPerShift), days.map(d=>d.rev)),
      corrLSRatioAcq: correlation(days.map(d=>d.leadsPerShift), days.map(d=>d.acq)),
      corrLeadsAcq: correlation(days.map(d=>d.leads), days.map(d=>d.acq)),
      corrAcqRev: correlation(days.map(d=>d.acq), days.map(d=>d.rev)),
      corrOrdersRev: correlation(days.map(d=>d.orders), days.map(d=>d.rev)),
      corrSOVAcq: 0, // Would need SOV field in daily agg
      // ROI
      totalCost, overallROI: totalCost>0?totalRev/totalCost:0,
      overallCPL: totalLeads>0?totalCost/totalLeads:0,
      overallCPA: totalAcq>0?totalCost/totalAcq:0,
    };
  }

  // ── Build mediaData from filtered records ───────────────────────────────────
  function computeMediaData(recs){
    const byMedia = {};
    for(const r of recs){
      const mName = R.media[r[MI]];
      if(!byMedia[mName]) byMedia[mName] = {leads:0,contacted:0,acq:0,rev:0,cost:0,imp:0};
      const m = byMedia[mName];
      m.leads += r[LI]; m.contacted += r[CTI]; m.acq += r[AI];
      m.rev += r[RI]; m.cost += r[MCI]; m.imp += r[IMPI];
    }
    const totalLeads = Object.values(byMedia).reduce((s,m)=>s+m.leads,0);
    const totalRev = Object.values(byMedia).reduce((s,m)=>s+m.rev,0);
    const totalAcq = Object.values(byMedia).reduce((s,m)=>s+m.acq,0);
    return Object.entries(byMedia).map(([media,m])=>({
      media, totalLeads: m.leads, totalRevenue: round2(m.rev),
      leadShare: totalLeads>0?m.leads/totalLeads:0,
      revenueShare: totalRev>0?m.rev/totalRev:0,
      acqShare: totalAcq>0?m.acq/totalAcq:0,
      conversionRate: m.leads>0?m.acq/m.leads:0,
      revenuePerLead: m.leads>0?m.rev/m.leads:0,
      contactedRate: m.leads>0?m.contacted/m.leads:0,
    })).sort((a,b)=>b.totalLeads-a.totalLeads);
  }

  // ── Build campData from filtered records ────────────────────────────────────
  function computeCampData(recs){
    const byCamp = {};
    for(const r of recs){
      const cName = R.camps[r[CI]];
      if(!byCamp[cName]) byCamp[cName] = {leads:0,contacted:0,acq:0,orders:0,rev:0,cost:0,imp:0};
      const c = byCamp[cName];
      c.leads += r[LI]; c.contacted += r[CTI]; c.acq += r[AI]; c.orders += r[OI];
      c.rev += r[RI]; c.cost += r[MCI]; c.imp += r[IMPI];
    }
    const totalLeads = Object.values(byCamp).reduce((s,c)=>s+c.leads,0);
    const totalRev = Object.values(byCamp).reduce((s,c)=>s+c.rev,0);
    const totalAcq = Object.values(byCamp).reduce((s,c)=>s+c.acq,0);
    return Object.entries(byCamp).map(([campaign,c])=>({
      campaign, totalLeads: c.leads, totalAcq: c.acq, totalRevenue: round2(c.rev),
      conversionRate: c.leads>0?c.acq/c.leads:0,
      revenuePerLead: c.leads>0?c.rev/c.leads:0,
      contactedRate: c.leads>0?c.contacted/c.leads:0,
      leadShare: totalLeads>0?c.leads/totalLeads:0,
      revenueShare: totalRev>0?c.rev/totalRev:0,
      acqShare: totalAcq>0?c.acq/totalAcq:0,
      revenuePerAcq: c.acq>0?c.rev/c.acq:0,
      totalCost: c.cost,
    }));
  }

  // ── Build segmentData (Media × Campaign) ────────────────────────────────────
  function computeSegmentData(recs){
    const bySeg = {};
    for(const r of recs){
      const key = R.media[r[MI]]+'|'+R.camps[r[CI]];
      if(!bySeg[key]) bySeg[key] = {media:R.media[r[MI]],campaign:R.camps[r[CI]],leads:0,contacted:0,acq:0,rev:0};
      const s = bySeg[key];
      s.leads += r[LI]; s.contacted += r[CTI]; s.acq += r[AI]; s.rev += r[RI];
    }
    const maxCR = Math.max(...Object.values(bySeg).map(s=>s.leads>0?s.contacted/s.leads:0));
    return Object.values(bySeg).map(s=>({
      media: s.media, campaign: s.campaign,
      totalLeads: s.leads, totalRevenue: round2(s.rev), totalAcquisitions: s.acq,
      contactedRate: s.leads>0?s.contacted/s.leads:null,
      qualityScore: s.leads>0?(s.contacted/s.leads)/maxCR:0,
      conversionRate: s.leads>0?s.acq/s.leads:null,
      revenuePerLead: s.leads>0?s.rev/s.leads:null,
      revenuePerAcq: s.acq>0?s.rev/s.acq:null,
    }));
  }

  // ── Build costSegData (Media × Campaign with costs) ─────────────────────────
  function computeCostSegData(recs){
    const bySeg = {};
    for(const r of recs){
      const catName = R.camps[r[CI]].includes('Hebrew')?'Hebrew':'Biblical';
      const key = R.media[r[MI]]+'|'+catName;
      if(!bySeg[key]) bySeg[key] = {media:R.media[r[MI]],category:catName,leads:0,contacted:0,acq:0,rev:0,cost:0,imp:0};
      const s = bySeg[key];
      s.leads += r[LI]; s.contacted += r[CTI]; s.acq += r[AI];
      s.rev += r[RI]; s.cost += r[MCI]; s.imp += r[IMPI];
    }
    return Object.values(bySeg).map(s=>({
      media: s.media, category: s.category,
      totalLeads: s.leads, totalAcq: s.acq,
      totalRevenue: Math.round(s.rev), totalCost: Math.round(s.cost),
      cpl: s.leads>0?round2(s.cost/s.leads):0,
      cpa: s.acq>0?Math.round(s.cost/s.acq):0,
      cvr: s.leads>0?round2(s.acq/s.leads*100):0,
      roi: s.cost>0?round2(s.rev/s.cost):null,
      rpl: s.leads>0?round2(s.rev/s.leads):0,
      contactedRate: s.leads>0?round1(s.contacted/s.leads*100):0,
      totalImpressions: s.imp,
    }));
  }

  // ── Build catData (ROI by campaign category) ────────────────────────────────
  function computeCatData(recs){
    const byCat = {};
    for(const r of recs){
      const catName = R.camps[r[CI]].includes('Hebrew')?'Hebrew':'Biblical';
      if(!byCat[catName]) byCat[catName] = {leads:0,contacted:0,acq:0,rev:0,cost:0,imp:0};
      const c = byCat[catName];
      c.leads += r[LI]; c.contacted += r[CTI]; c.acq += r[AI];
      c.rev += r[RI]; c.cost += r[MCI]; c.imp += r[IMPI];
    }
    return Object.entries(byCat).map(([cat,c])=>({
      category: cat,
      totalLeads: c.leads, totalAcq: c.acq,
      totalRevenue: Math.round(c.rev), totalCost: Math.round(c.cost),
      cpl: c.leads>0?round2(c.cost/c.leads):0,
      cpa: c.acq>0?Math.round(c.cost/c.acq):0,
      rpl: c.leads>0?round2(c.rev/c.leads):0,
      cvr: c.leads>0?round2(c.acq/c.leads*100):0,
      roi: c.cost>0?round2(c.rev/c.cost):null,
      rpa: c.acq>0?Math.round(c.rev/c.acq):0,
      contactedRate: c.leads>0?round1(c.contacted/c.leads*100):0,
      totalImpressions: c.imp,
    }));
  }

  // ── Monthly data from day aggregation ───────────────────────────────────────
  function computeMonthlyData(days){
    const byMonth = {};
    for(const d of days){
      const m = d.date.substring(0,7);
      if(!byMonth[m]) byMonth[m] = {days:[],totalLeads:0,totalAcq:0,totalOrders:0,totalRev:0,totalCost:0};
      const mo = byMonth[m];
      mo.days.push(d);
      mo.totalLeads += d.leads; mo.totalAcq += d.acq; mo.totalOrders += d.orders;
      mo.totalRev += d.rev; mo.totalCost += d.cost;
    }
    return Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0])).map(([month,mo])=>{
      const n = mo.days.length;
      return {
        month, totalLeads: mo.totalLeads, totalAcquisitions: mo.totalAcq,
        totalOrders: mo.totalOrders, totalRevenue: round2(mo.totalRev),
        avgRevenue: n>0?round2(mo.totalRev/n):0,
        avgAcq: n>0?round2(mo.totalAcq/n):0,
        avgOrders: n>0?round2(mo.totalOrders/n):0,
        avgContactedRatio: n>0?round4(mean(mo.days.map(d=>d.contactedRatio))):0,
        avgLeadsPerShift: n>0?round2(mean(mo.days.map(d=>d.leadsPerShift))):0,
        count: n,
        totalCost: mo.totalCost,
      };
    });
  }

  // ── Ratio bin data ──────────────────────────────────────────────────────────
  function computeRatioBinData(days){
    const edges = [0,10,15,20,25,30,35,40,50,999];
    const labels = ['<10','10–15','15–20','20–25','25–30','30–35','35–40','40–50','50+'];
    const bins = labels.map(()=>({count:0,acq:0,rev:0,orders:0,rpl:0,contacted:0,leads:0,rplArr:[],contArr:[]}));
    for(const d of days){
      const ls = d.leadsPerShift;
      for(let i=0;i<edges.length-1;i++){
        if(ls>=edges[i] && ls<edges[i+1]){
          bins[i].count++;
          bins[i].acq += d.acq; bins[i].rev += d.rev; bins[i].orders += d.orders;
          bins[i].leads += d.leads;
          bins[i].rplArr.push(d.revenuePerLead);
          bins[i].contArr.push(d.contactedRatio);
          break;
        }
      }
    }
    return bins.map((b,i)=>({
      bin: labels[i], count: b.count,
      avgAcq: b.count>0?round2(b.acq/b.count):0,
      avgRevenue: b.count>0?round2(b.rev/b.count):0,
      avgOrders: b.count>0?round2(b.orders/b.count):0,
      avgRevenuePerLead: b.rplArr.length>0?round2(mean(b.rplArr)):0,
      avgContacted: b.contArr.length>0?round4(mean(b.contArr)):0,
      totalLeads: b.leads,
    })).filter(b=>b.count>0);
  }

  // ── DOW data ────────────────────────────────────────────────────────────────
  function computeDowData(days){
    const names = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const byDow = {};
    for(const d of days){
      const name = names[d.pyDow];
      if(!byDow[name]) byDow[name] = [];
      byDow[name].push(d);
    }
    const result = {};
    for(const [name, arr] of Object.entries(byDow)){
      result[name] = {
        avgAcq: round2(mean(arr.map(d=>d.acq))),
        avgRevenue: round2(mean(arr.map(d=>d.rev))),
        avgContactedRatio: round4(mean(arr.map(d=>d.contactedRatio))),
        avgLeadsPerShift: round2(mean(arr.map(d=>d.leadsPerShift))),
        count: arr.length,
      };
    }
    return result;
  }

  // ── Monthly ROI by category ─────────────────────────────────────────────────
  function computeMonthlyRoi(recs){
    const byCatMonth = {};
    for(const r of recs){
      const catName = R.camps[r[CI]].includes('Hebrew')?'Hebrew':'Biblical';
      const month = R.dates[r[DI]].substring(0,7);
      const key = catName+'|'+month;
      if(!byCatMonth[key]) byCatMonth[key] = {rev:0,cost:0,leads:0,acq:0};
      const c = byCatMonth[key];
      c.rev += r[RI]; c.cost += r[MCI]; c.leads += r[LI]; c.acq += r[AI];
    }
    const months = [...new Set(recs.map(r=>R.dates[r[DI]].substring(0,7)))].sort();
    return months.map(m=>{
      const bib = byCatMonth['Biblical|'+m];
      const heb = byCatMonth['Hebrew|'+m];
      return {
        month: m,
        biblicalROI: bib&&bib.cost>0?round2(bib.rev/bib.cost):null,
        hebrewROI: heb&&heb.cost>0?round2(heb.rev/heb.cost):null,
        biblicalCPL: bib&&bib.leads>0?round2(bib.cost/bib.leads):null,
        hebrewCPL: heb&&heb.leads>0?round2(heb.cost/heb.leads):null,
      };
    });
  }

  // ── ROI KPIs ────────────────────────────────────────────────────────────────
  function computeRoiKpis(recs){
    const tr = sum(recs,RI), tc = sum(recs,MCI), tl = sum(recs,LI), ta = sum(recs,AI), ti = sum(recs,IMPI);
    return {
      totalRevenue: round2(tr), totalCost: round2(tc),
      overallROI: tc>0?round2(tr/tc):0,
      overallCPL: tl>0?round2(tc/tl):0,
      overallCPA: ta>0?Math.round(tc/ta):0,
      totalImpressions: ti,
      cpm: ti>0?round2(tc/ti*1000):0,
    };
  }

  // ── Top revenue days ────────────────────────────────────────────────────────
  function computeTopRevDays(days, n=30){
    return [...days].sort((a,b)=>b.rev-a.rev).slice(0,n).map(d=>({
      date: d.date, dayName: d.dayName,
      totalLeads: d.leads, totalShift: round3(d.shift),
      totalAcquisitions: d.acq, totalRevenue: round2(d.rev),
      leadsPerShift: round2(d.leadsPerShift),
      contactedRatio: round4(d.contactedRatio),
      isWeekend: d.isWeekend,
    }));
  }

  // ── Top ROI days ────────────────────────────────────────────────────────────
  function computeTopRoiDays(days, n=30){
    return days.filter(d=>d.cost>0).sort((a,b)=>(b.roi||0)-(a.roi||0)).slice(0,n).map(d=>({
      date: d.date, totalRevenue: round2(d.rev), totalCost: round2(d.cost),
      roi: d.roi!==null?round2(d.roi):0,
      totalLeads: d.leads, totalAcq: d.acq,
    }));
  }

  // ── Daily ROI scatter ───────────────────────────────────────────────────────
  function computeDailyRoiScatter(days){
    return days.map(d=>({
      date: d.date, totalRevenue: round2(d.rev), totalCost: round2(d.cost),
      roi: d.roi!==null?round2(d.roi):null,
      totalLeads: d.leads, totalAcq: d.acq,
    }));
  }

  // ── Stat helpers ────────────────────────────────────────────────────────────
  function mean(arr){ if(!arr.length) return 0; return arr.reduce((s,v)=>s+v,0)/arr.length; }
  function percentile(sorted, p){
    if(!sorted.length) return 0;
    const idx = (p/100)*(sorted.length-1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo===hi ? sorted[lo] : sorted[lo]*(hi-idx) + sorted[hi]*(idx-lo);
  }
  function correlation(xs, ys){
    const n = xs.length;
    if(n<3) return 0;
    const mx = mean(xs), my = mean(ys);
    let num=0, dx=0, dy=0;
    for(let i=0;i<n;i++){
      const a=xs[i]-mx, b=ys[i]-my;
      num+=a*b; dx+=a*a; dy+=b*b;
    }
    return dx>0&&dy>0 ? num/Math.sqrt(dx*dy) : 0;
  }
  function round1(v){ return Math.round(v*10)/10; }
  function round2(v){ return Math.round(v*100)/100; }
  function round3(v){ return Math.round(v*1000)/1000; }
  function round4(v){ return Math.round(v*10000)/10000; }

  // ── Master apply function ───────────────────────────────────────────────────
  function apply(startDate, endDate){
    const si = R.dates.indexOf(startDate);
    const ei = R.dates.indexOf(endDate);
    if(si<0||ei<0||si>ei) return null;
    _startIdx = si; _endIdx = ei;
    _isFiltered = (si > 0 || ei < R.dates.length-1);

    const recs = filteredRecords();
    const days = buildDayAgg(recs);
    const kpis = computeKPIs(recs, days);

    return {
      kpis,
      scatterData: filteredScatter(),
      monthlyData: computeMonthlyData(days),
      ratioBinData: computeRatioBinData(days),
      segmentData: computeSegmentData(recs),
      mediaData: computeMediaData(recs),
      campData: computeCampData(recs),
      dowData: computeDowData(days),
      topRevDays: computeTopRevDays(days),
      roiKpis: computeRoiKpis(recs),
      catData: computeCatData(recs),
      costSegData: computeCostSegData(recs),
      monthlyRoi: computeMonthlyRoi(recs),
      dailyRoiScatter: computeDailyRoiScatter(days),
      topRoiDays: computeTopRoiDays(days),
      days, // pass through for custom use
    };
  }

  function reset(){
    _startIdx = 0; _endIdx = R.dates.length-1; _isFiltered = false;
    return null; // signals: use FULL data
  }

  // ── Chart instance management ───────────────────────────────────────────────
  function storeChart(id, instance){ _chartInstances[id] = instance; }
  function getChart(id){ return _chartInstances[id]; }
  function destroyChart(id){
    if(_chartInstances[id]){ _chartInstances[id].destroy(); delete _chartInstances[id]; }
  }
  function destroyAll(){
    for(const id of Object.keys(_chartInstances)){
      _chartInstances[id].destroy();
    }
    _chartInstances = {};
  }

  return {
    apply, reset, isFiltered, getDateRange, filteredDates,
    storeChart, getChart, destroyChart, destroyAll,
    R, // expose raw data ref
  };
})();
