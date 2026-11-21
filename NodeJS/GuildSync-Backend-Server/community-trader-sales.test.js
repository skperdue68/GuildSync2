import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCommunityStatistics,buyerRaffleWindow} from './community-statistics.js';
import {monthlySalesEndAtOrAfter} from './raffle-schedule.js';

// A real 50/50 cutoff, so the raffle period is the calendar schedule rather than a fixture.
const RAFFLE_END=monthlySalesEndAtOrAfter(1800000000);

test('trader cards rank the last 14 days and never publish gold totals',()=>{
 const now=10000000, window=14*86400;
 const traderSales=[
  {seller:'Alice',quantity:2,net:5000,event_timestamp:now},
  {seller:'alice',quantity:3,net:1000,event_timestamp:now-1},
  {seller:'Bob',quantity:10,net:2000,event_timestamp:now},
  {seller:'Casey',quantity:4,net:9000,event_timestamp:now-1},
  {seller:'Boundary',quantity:1,net:1,event_timestamp:now-window},
  {seller:'Old',quantity:100,net:90000,event_timestamp:now-window-1},
  {seller:'Future',quantity:100,net:90000,event_timestamp:now+1}
 ];
 const report=buildCommunityStatistics({now,traderSales});
 const sales=report.highlights.find(h=>h.id==='trader-sales');
 assert.equal(sales.title,'Market Moguls (last 14 days, Top 5)');
 assert.equal(sales.hideValue,true);
 assert.deepEqual(sales.rows.map(r=>r.name),['Casey','Alice','Bob','Boundary']);
 assert.ok(sales.rows.every(r=>!('value' in r)),'gold values must not reach the report payload');
 const items=report.highlights.find(h=>h.id==='trader-items');
 assert.equal(items.title,'Pack Mules (last 14 days, Top 5)');
 assert.equal(items.unit,'items');
 assert.deepEqual(items.rows.map(r=>[r.name,r.value]),[['Bob',10],['Alice',5],['Casey',4],['Boundary',1]]);
 const ids=report.highlights.map(h=>h.id);
 assert.ok(ids.indexOf('raffle-spending')<ids.indexOf('trader-sales'));
 assert.ok(ids.indexOf('trader-sales')<ids.indexOf('trader-items'));
 assert.ok(ids.indexOf('trader-items')<ids.indexOf('guild-joins'));
 assert.deepEqual(report.highlights.slice(-2).map(h=>h.id),['guild-joins','discord-joins']);
});

test('buyer rankings count the current 50/50 raffle and split current members from non-members',()=>{
 const now=RAFFLE_END-3600;
 const {salesStart}=buyerRaffleWindow(now);
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1},{account_name:'Bob',in_roster:1},{account_name:'Former',in_roster:0}];
 const traderSales=[
  {seller:'Seller',buyer:'Alice',quantity:2,price:5000,net:4000,event_timestamp:now},
  {seller:'Seller',buyer:'alice',quantity:1,price:1000,net:900,event_timestamp:now-1},
  {seller:'Seller',buyer:'Bob',quantity:3,price:7000,net:500,event_timestamp:now-2},
  {seller:'Seller',buyer:'Outsider',quantity:1,price:3000,net:2700,event_timestamp:now-3},
  {seller:'Former',buyer:'Alice',quantity:9,price:90000,net:90000,event_timestamp:now},
  {seller:'Former',buyer:'Walkin',quantity:1,price:2000,net:1800,event_timestamp:now-4},
  {seller:'Seller',buyer:'LastRaffle',quantity:1,price:700,net:600,event_timestamp:salesStart-1},
  {seller:'Seller',buyer:'Future',quantity:1,price:60000,net:60000,event_timestamp:now+1}
 ];
 const report=buildCommunityStatistics({now,roster,traderSales});
 const members=report.highlights.find(h=>h.id==='trader-member-buyers');
 assert.equal(members.title,'Guild Regulars (current 50/50 raffle, Top 5)');
 assert.match(members.description,/from the previous cutoff to now/);
 // The card covers one raffle: purchases from the raffle before it are excluded.
 assert.ok(!members.description.includes('LastRaffle'));
 assert.equal(members.hideValue,true);
 // Ranked by price paid: Bob's 7000 beats Alice's 6000 even though his post-tax net is lower.
 assert.deepEqual(members.rows.map(r=>r.name),['Bob','Alice']);
 assert.ok(members.rows.every(r=>!('value' in r)),'gold values must not reach the report payload');
 const visitors=report.highlights.find(h=>h.id==='trader-visitor-buyers');
 assert.equal(visitors.title,'Window Shoppers (current 50/50 raffle, Top 5)');
 assert.equal(visitors.hideValue,true);
 // Anyone off the roster counts, even when a member who has since left listed the item.
 assert.deepEqual(visitors.rows.map(r=>r.name),['Outsider','Walkin']);
 assert.ok(visitors.rows.every(r=>!('value' in r)),'gold values must not reach the report payload');
 // No trader card may carry gold or per-sale amounts in any field.
 const privateCards=report.highlights.filter(h=>['trader-sales','trader-member-buyers','trader-visitor-buyers'].includes(h.id));
 assert.doesNotMatch(JSON.stringify(privateCards),/"(value|price|net|tax)":/);
 const ids=report.highlights.map(h=>h.id);
 assert.ok(ids.indexOf('trader-items')<ids.indexOf('trader-member-buyers'));
 assert.ok(ids.indexOf('trader-member-buyers')<ids.indexOf('trader-visitor-buyers'));
 assert.ok(ids.indexOf('trader-visitor-buyers')<ids.indexOf('guild-joins'));
 assert.deepEqual(ids.slice(-2),['guild-joins','discord-joins']);
});

test('a closed 50/50 raffle stays on the buyer cards for a few hours, then resets',()=>{
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1}];
 const traderSales=[{seller:'Seller',buyer:'Alice',quantity:1,price:1000,net:900,event_timestamp:RAFFLE_END-60}];
 const names=now=>buildCommunityStatistics({now,roster,traderSales})
  .highlights.find(h=>h.id==='trader-member-buyers').rows.map(r=>r.name);
 assert.deepEqual(names(RAFFLE_END-60),['Alice'],'during the raffle the purchase counts');
 assert.deepEqual(names(RAFFLE_END+2*3600),['Alice'],'the just-closed raffle is still readable');
 assert.deepEqual(names(RAFFLE_END+4*3600),[],'after the linger the next raffle starts empty');
 // The reset is raffle-to-raffle: the new period opens at the cutoff it followed.
 const next=buyerRaffleWindow(RAFFLE_END+4*3600);
 assert.equal(next.salesStart,RAFFLE_END+1);
 assert.ok(next.salesEnd>next.salesStart);
});

test('the raffle linger is configurable and the buyer card text follows it',()=>{
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1}];
 const traderSales=[{seller:'Seller',buyer:'Alice',quantity:1,price:1000,net:900,event_timestamp:RAFFLE_END-60}];
 const card=(now,env)=>buildCommunityStatistics({now,roster,traderSales,env})
  .highlights.find(h=>h.id==='trader-member-buyers');
 // The three-hour default keeps the closed raffle readable after the cutoff.
 assert.match(card(RAFFLE_END-60,{}).description,/stays listed for 3 hours/);
 assert.deepEqual(card(RAFFLE_END+2*3600,{}).rows.map(r=>r.name),['Alice']);
 // A longer linger keeps it, and the sentence names the configured hours.
 const longer={GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS:'6'};
 assert.match(card(RAFFLE_END-60,longer).description,/stays listed for 6 hours/);
 assert.deepEqual(card(RAFFLE_END+5*3600,longer).rows.map(r=>r.name),['Alice']);
 assert.deepEqual(card(RAFFLE_END+7*3600,longer).rows.map(r=>r.name),[]);
 // Fractional hours are allowed and read naturally.
 assert.match(card(RAFFLE_END-60,{GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS:'1.5'}).description,/stays listed for 1.5 hours/);
 // Zero replaces the card at the next refresh instead of lingering.
 const none={GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS:'0'};
 assert.match(card(RAFFLE_END-60,none).description,/replaced at the next refresh/);
 assert.deepEqual(card(RAFFLE_END+60,none).rows.map(r=>r.name),[]);
 // An unusable value falls back to the default rather than breaking the report.
 for(const bad of ['-1','169','abc',''])
  assert.match(card(RAFFLE_END-60,{GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS:bad}).description,/stays listed for 3 hours/);
});

test('buyer cards stop exactly at the raffle boundaries',()=>{
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1},{account_name:'Before',in_roster:1},{account_name:'After',in_roster:1}];
 const now=RAFFLE_END-3600;
 const {salesStart}=buyerRaffleWindow(now);
 const rows=[
  {seller:'Seller',buyer:'Alice',quantity:1,price:1000,net:900,event_timestamp:salesStart},
  {seller:'Seller',buyer:'Before',quantity:1,price:9000,net:9000,event_timestamp:salesStart-1},
  {seller:'Seller',buyer:'After',quantity:1,price:9000,net:9000,event_timestamp:RAFFLE_END+60}
 ];
 const card=buildCommunityStatistics({now,roster,traderSales:rows}).highlights.find(h=>h.id==='trader-member-buyers');
 // The previous raffle's last second is out, the current raffle's first second is in,
 // and a sale recorded after the cutoff waits for the next raffle.
 assert.deepEqual(card.rows.map(r=>r.name),['Alice']);
 const afterClose=buildCommunityStatistics({now:RAFFLE_END+2*3600,roster,traderSales:rows}).highlights.find(h=>h.id==='trader-member-buyers');
 assert.deepEqual(afterClose.rows.map(r=>r.name),['Alice']);
 const nextRaffle=buildCommunityStatistics({now:RAFFLE_END+4*3600,roster,traderSales:rows}).highlights.find(h=>h.id==='trader-member-buyers');
 assert.deepEqual(nextRaffle.rows.map(r=>r.name),['After']);
});
