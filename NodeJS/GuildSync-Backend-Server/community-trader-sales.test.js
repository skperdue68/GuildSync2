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

test('30-day buyer rankings split current members from non-members and never publish gold',()=>{
 const now=10000000,month=30*86400;
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1},{account_name:'Bob',in_roster:1},{account_name:'Former',in_roster:0}];
 const traderSales=[
  {seller:'Seller',buyer:'Alice',quantity:2,price:5000,net:4000,event_timestamp:now},
  {seller:'Seller',buyer:'alice',quantity:1,price:1000,net:900,event_timestamp:now-1},
  {seller:'Seller',buyer:'Bob',quantity:3,price:7000,net:500,event_timestamp:now-2},
  {seller:'Seller',buyer:'Outsider',quantity:1,price:3000,net:2700,event_timestamp:now-3},
  {seller:'Former',buyer:'Alice',quantity:9,price:90000,net:90000,event_timestamp:now},
  {seller:'Seller',buyer:'OldOutsider',quantity:1,price:700,net:600,event_timestamp:now-month},
  {seller:'Seller',buyer:'TooOld',quantity:1,price:60000,net:60000,event_timestamp:now-month-1},
  {seller:'Seller',buyer:'Future',quantity:1,price:60000,net:60000,event_timestamp:now+1}
 ];
 const report=buildCommunityStatistics({now,roster,traderSales});
 const members=report.highlights.find(h=>h.id==='trader-member-buyers');
 assert.equal(members.title,'Guild member buyers (last 30 days, Top 5)');
 assert.equal(members.hideValue,true);
 // Ranked by price paid: Bob's 7000 beats Alice's 6000 even though his post-tax net is lower.
 assert.deepEqual(members.rows.map(r=>r.name),['Bob','Alice']);
 assert.ok(members.rows.every(r=>!('value' in r)),'gold values must not reach the report payload');
 const visitors=report.highlights.find(h=>h.id==='trader-visitor-buyers');
 assert.equal(visitors.hideValue,true);
 assert.deepEqual(visitors.rows.map(r=>r.name),['Outsider','OldOutsider']);
 assert.ok(visitors.rows.every(r=>!('value' in r)),'gold values must not reach the report payload');
 const ids=report.highlights.map(h=>h.id);
 assert.ok(ids.indexOf('trader-items')<ids.indexOf('trader-member-buyers'));
 assert.ok(ids.indexOf('trader-member-buyers')<ids.indexOf('trader-visitor-buyers'));
 assert.ok(ids.indexOf('trader-visitor-buyers')<ids.indexOf('guild-joins'));
 assert.deepEqual(ids.slice(-2),['guild-joins','discord-joins']);
});
