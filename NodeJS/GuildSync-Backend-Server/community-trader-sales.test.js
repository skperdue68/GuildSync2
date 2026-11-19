import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCommunityStatistics} from './community-statistics.js';

test('weekly trader cards rank the last seven days and never publish gold totals',()=>{
 const now=10000000, week=7*86400;
 const traderSales=[
  {seller:'Alice',quantity:2,net:5000,event_timestamp:now},
  {seller:'alice',quantity:3,net:1000,event_timestamp:now-1},
  {seller:'Bob',quantity:10,net:2000,event_timestamp:now},
  {seller:'Casey',quantity:4,net:9000,event_timestamp:now-1},
  {seller:'Boundary',quantity:1,net:1,event_timestamp:now-week},
  {seller:'Old',quantity:100,net:90000,event_timestamp:now-week-1},
  {seller:'Future',quantity:100,net:90000,event_timestamp:now+1}
 ];
 const report=buildCommunityStatistics({now,traderSales});
 const sales=report.highlights.find(h=>h.id==='trader-sales');
 assert.equal(sales.title,'Highest guild trader sales (last 7 days, Top 5)');
 assert.equal(sales.hideValue,true);
 assert.deepEqual(sales.rows.map(r=>r.name),['Casey','Alice','Bob','Boundary']);
 assert.ok(sales.rows.every(r=>!('value' in r)),'gold values must not reach the report payload');
 const items=report.highlights.find(h=>h.id==='trader-items');
 assert.equal(items.title,'Most items sold (last 7 days, Top 5)');
 assert.equal(items.unit,'items');
 assert.deepEqual(items.rows.map(r=>[r.name,r.value]),[['Bob',10],['Alice',5],['Casey',4],['Boundary',1]]);
 const ids=report.highlights.map(h=>h.id);
 assert.ok(ids.indexOf('raffle-spending')<ids.indexOf('trader-sales'));
 assert.ok(ids.indexOf('trader-sales')<ids.indexOf('trader-items'));
 assert.ok(ids.indexOf('trader-items')<ids.indexOf('guild-joins'));
 assert.deepEqual(report.highlights.slice(-2).map(h=>h.id),['guild-joins','discord-joins']);
});
