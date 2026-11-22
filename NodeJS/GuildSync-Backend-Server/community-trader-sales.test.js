import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCommunityStatistics,buyerRaffleWindow} from './community-statistics.js';
import {monthlySalesEndAtOrAfter} from './raffle-schedule.js';

// A real 50/50 cutoff, so the raffle period is the calendar schedule rather than a fixture.
const RAFFLE_END=monthlySalesEndAtOrAfter(1800000000);

test('trader cards can rank the last 14 days and never publish gold totals',()=>{
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
 const report=buildCommunityStatistics({now,traderSales,env:{GUILDSYNC_COMMUNITY_TRADER_WINDOW:'14 days'}});
 const sales=report.highlights.find(h=>h.id==='trader-sales');
 assert.equal(sales.title,'Market Moguls (last 14 days, Top 5)');
 assert.equal(sales.hideValue,true);
 assert.deepEqual(sales.rows.map(r=>r.name),['Casey','Alice','Bob','Boundary']);
 assert.ok(sales.rows.every(r=>!('value' in r)),'gold values must not reach the report payload');
 const items=report.highlights.find(h=>h.id==='trader-items');
 assert.equal(items.title,'Pack Mules (last 14 days, Top 5)');
 assert.match(items.description,/counted back from this refresh/);
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
 // The card states the real span and the reset time, not just a number of hours.
 assert.match(members.description,/Counts the 50\/50 raffle from Dec 19, 2026, 8:00 PM EST to Jan 30, 2027, 8:00 PM EST\./);
 assert.match(members.description,/It stays listed until Jan 30, 2027, 9:00 PM EST \(1 hour after the draw\)/);
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
 // A viewer role (the default here) gets no gold or per-sale amounts in any field.
 const privateCards=report.highlights.filter(h=>['trader-sales','trader-member-buyers','trader-visitor-buyers'].includes(h.id));
 assert.doesNotMatch(JSON.stringify(privateCards),/"(value|price|net|tax)":/);
 const ids=report.highlights.map(h=>h.id);
 assert.ok(ids.indexOf('trader-items')<ids.indexOf('trader-member-buyers'));
 assert.ok(ids.indexOf('trader-member-buyers')<ids.indexOf('trader-visitor-buyers'));
 assert.ok(ids.indexOf('trader-visitor-buyers')<ids.indexOf('guild-joins'));
 assert.deepEqual(ids.slice(-2),['guild-joins','discord-joins']);
});

test('trader gold is listed for users and admins but withheld from viewers',()=>{
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1}];
 const now=RAFFLE_END-3600;
 const traderSales=[
  {seller:'Seller',buyer:'Alice',quantity:2,price:5000,net:4000,event_timestamp:now},
  {seller:'Other',buyer:'Outsider',quantity:1,price:3000,net:2700,event_timestamp:now-10}
 ];
 const cards=viewerRole=>buildCommunityStatistics({now,roster,traderSales,viewerRole}).highlights;
 const pick=(role,id)=>cards(role).find(h=>h.id===id);
 const gold=pick('user','trader-member-buyers');
 assert.equal(gold.hideValue,undefined);
 assert.equal(gold.unit,'gold');
 assert.deepEqual(gold.rows.map(r=>[r.name,r.value]),[['Alice',5000]]);
 assert.deepEqual(pick('user','trader-visitor-buyers').rows.map(r=>[r.name,r.value]),[['Outsider',3000]]);
 assert.deepEqual(pick('user','trader-sales').rows.map(r=>[r.name,r.value]),[['Seller',4000],['Other',2700]]);
 for(const id of ['trader-sales','trader-member-buyers','trader-visitor-buyers'])
  assert.match(pick('user',id).description,/Gold amounts are listed/);
 // An admin sees the same amounts.
 assert.deepEqual(pick('admin','trader-member-buyers').rows.map(r=>[r.name,r.value]),[['Alice',5000]]);
 // A plain viewer, or any role the server does not recognise, gets names and order only.
 for(const role of ['viewer',undefined,'','owner']){
  for(const id of ['trader-sales','trader-member-buyers','trader-visitor-buyers']){
   const card=pick(role,id);
   assert.equal(card.hideValue,true);
   assert.equal(card.unit,'');
   assert.ok(card.rows.every(r=>!('value' in r)),'viewers must not receive gold');
   assert.doesNotMatch(card.description,/Gold amounts are listed/);
  }
 }
 assert.deepEqual(pick('viewer','trader-member-buyers').rows.map(r=>r.name),['Alice']);
 // The item card is quantity-only for every role.
 assert.equal(pick('user','trader-items').unit,'items');
 assert.equal(pick('viewer','trader-items').unit,'items');
});

test('a closed 50/50 raffle stays on the buyer cards until an hour after its draw, then resets',()=>{
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1}];
 const traderSales=[{seller:'Seller',buyer:'Alice',quantity:1,price:1000,net:900,event_timestamp:RAFFLE_END-60}];
 const names=now=>buildCommunityStatistics({now,roster,traderSales})
  .highlights.find(h=>h.id==='trader-member-buyers').rows.map(r=>r.name);
 assert.deepEqual(names(RAFFLE_END-60),['Alice'],'during the raffle the purchase counts');
 // The draw is one hour after the sales cutoff, so the standings survive until 9 PM Eastern.
 assert.deepEqual(names(RAFFLE_END+2*3600-60),['Alice'],'the just-closed raffle is still readable');
 assert.deepEqual(names(RAFFLE_END+2*3600),[],'at the end of the linger the next raffle starts empty');
 // The reset is raffle-to-raffle: the new period opens at the draw that just happened.
 const next=buyerRaffleWindow(RAFFLE_END+2*3600);
 assert.equal(next.salesStart,RAFFLE_END+3600+1);
 assert.ok(next.salesEnd>next.salesStart);
});

test('the raffle linger is configurable and the buyer card text follows it',()=>{
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1}];
 const traderSales=[{seller:'Seller',buyer:'Alice',quantity:1,price:1000,net:900,event_timestamp:RAFFLE_END-60}];
 const card=(now,env)=>buildCommunityStatistics({now,roster,traderSales,env})
  .highlights.find(h=>h.id==='trader-member-buyers');
 // The one-hour default keeps the closed raffle readable for an hour after the draw.
 assert.match(card(RAFFLE_END-60,{}).description,/stays listed until Jan 30, 2027, 9:00 PM EST \(1 hour after the draw\)/);
 assert.deepEqual(card(RAFFLE_END+2*3600-60,{}).rows.map(r=>r.name),['Alice']);
 assert.deepEqual(card(RAFFLE_END+2*3600,{}).rows.map(r=>r.name),[]);
 // A longer linger keeps it, and the sentence names the configured hours.
 const longer={GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS:'6'};
 assert.match(card(RAFFLE_END-60,longer).description,/stays listed until Jan 31, 2027, 2:00 AM EST \(6 hours after the draw\)/);
 assert.deepEqual(card(RAFFLE_END+6*3600,longer).rows.map(r=>r.name),['Alice']);
 assert.deepEqual(card(RAFFLE_END+7*3600,longer).rows.map(r=>r.name),[]);
 // Fractional hours are allowed and read naturally.
 assert.match(card(RAFFLE_END-60,{GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS:'1.5'}).description,/stays listed until Jan 30, 2027, 9:30 PM EST \(1.5 hours after the draw\)/);
 // Zero hands the cards to the next raffle at the draw instead of lingering.
 const none={GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS:'0'};
 assert.match(card(RAFFLE_END-60,none).description,/The next raffle replaces it at that draw\./);
 assert.deepEqual(card(RAFFLE_END+3600-60,none).rows.map(r=>r.name),['Alice']);
 assert.deepEqual(card(RAFFLE_END+3600,none).rows.map(r=>r.name),[]);
 // An unusable value falls back to the default rather than breaking the report.
 for(const bad of ['-1','169','abc',''])
  assert.match(card(RAFFLE_END-60,{GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS:bad}).description,/\(1 hour after the draw\)/);
});

test('buyer cards stop exactly at the draw boundaries',()=>{
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1},{account_name:'Before',in_roster:1},{account_name:'Tail',in_roster:1},{account_name:'After',in_roster:1}];
 const now=RAFFLE_END-3600;
 const {salesStart,salesEnd,drawTime}=buyerRaffleWindow(now);
 // One raffle counts from the previous draw through its own draw.
 assert.equal(drawTime,RAFFLE_END+3600);
 assert.equal(salesEnd,drawTime);
 const rows=[
  {seller:'Seller',buyer:'Alice',quantity:1,price:1000,net:900,event_timestamp:salesStart},
  {seller:'Seller',buyer:'Before',quantity:1,price:9000,net:9000,event_timestamp:salesStart-1},
  {seller:'Seller',buyer:'Tail',quantity:1,price:500,net:400,event_timestamp:RAFFLE_END+60},
  {seller:'Seller',buyer:'After',quantity:1,price:9000,net:9000,event_timestamp:drawTime+60}
 ];
 const cardAt=now=>buildCommunityStatistics({now,roster,traderSales:rows}).highlights.find(h=>h.id==='trader-member-buyers');
 // The previous raffle's last second is out and the current raffle's first second is in.
 assert.deepEqual(cardAt(now).rows.map(r=>r.name),['Alice']);
 // A sale recorded in the hour between cutoff and draw still belongs to that raffle.
 assert.deepEqual(cardAt(RAFFLE_END+30*60).rows.map(r=>r.name),['Alice','Tail']);
 // Sales after the draw wait for the next raffle, which the cards reach an hour later.
 assert.deepEqual(cardAt(RAFFLE_END+2*3600).rows.map(r=>r.name),['After']);
});

test('all four trader cards share the raffle span by default',()=>{
 const now=RAFFLE_END-3600;
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1}];
 const {salesStart,salesEnd}=buyerRaffleWindow(now);
 const traderSales=[
  {seller:'Seller',buyer:'Alice',quantity:2,price:1000,net:900,event_timestamp:now},
  {seller:'Earlier',buyer:'Alice',quantity:1,price:500,net:400,event_timestamp:salesStart-1},
  {seller:'AtDraw',buyer:'Alice',quantity:1,price:500,net:400,event_timestamp:salesEnd}
 ];
 const report=buildCommunityStatistics({now,roster,traderSales});
 const sales=report.highlights.find(h=>h.id==='trader-sales');
 assert.equal(sales.title,'Market Moguls (current 50/50 raffle, Top 5)');
 assert.ok(sales.description.includes('Counts the 50/50 raffle from'));
 assert.ok(sales.description.includes('Trader data through'));
 // The previous raffle's last second and the future draw sale stay out of this span.
 assert.deepEqual(sales.rows.map(r=>r.name),['Seller']);
 assert.equal(report.traderLatestAt,salesEnd,'the report names the newest recorded sale');
});

test('member matching ignores the ESO @ prefix on trader names',()=>{
 const now=RAFFLE_END-3600;
 const roster=[{account_name:'Alice',in_roster:1},{account_name:'Bob',in_roster:1}];
 const traderSales=[
  {seller:'@Bob',buyer:'@Alice',quantity:1,price:1000,net:900,event_timestamp:now},
  {seller:'@Bob',buyer:'Outsider',quantity:1,price:2000,net:1800,event_timestamp:now}
 ];
 const report=buildCommunityStatistics({now,roster,traderSales});
 assert.deepEqual(report.highlights.find(h=>h.id==='trader-member-buyers').rows.map(r=>r.name),['Alice']);
 assert.deepEqual(report.highlights.find(h=>h.id==='trader-visitor-buyers').rows.map(r=>r.name),['Outsider']);
});

test('the trader cards follow the administrator settings',()=>{
 const now=RAFFLE_END-3600;
 const roster=[{account_name:'Seller',in_roster:1},{account_name:'Alice',in_roster:1}];
 const traderSales=['A','B','C'].map((name,index)=>({seller:'Seller',buyer:name,quantity:1,price:1000-index,net:900,event_timestamp:now}));
 const cards=(env,viewerRole)=>buildCommunityStatistics({now,roster,traderSales,env,viewerRole}).highlights;
 const top=cards({GUILDSYNC_COMMUNITY_TRADER_TOP_LIMIT:'2'});
 assert.equal(top.find(h=>h.id==='trader-visitor-buyers').rows.length,2);
 assert.match(top.find(h=>h.id==='trader-sales').title,/Top 2/);
 // Gold policy: admins only, then never.
 const adminOnly={GUILDSYNC_COMMUNITY_TRADER_GOLD_VISIBILITY:'admin'};
 assert.equal(cards(adminOnly,'user').find(h=>h.id==='trader-sales').hideValue,true);
 assert.equal(cards(adminOnly,'admin').find(h=>h.id==='trader-sales').hideValue,undefined);
 assert.equal(cards({GUILDSYNC_COMMUNITY_TRADER_GOLD_VISIBILITY:'never'},'admin').find(h=>h.id==='trader-sales').hideValue,true);
 // Hiding a card removes it from the report entirely.
 const hidden=cards({GUILDSYNC_COMMUNITY_HIDDEN_HIGHLIGHTS:'trader-visitor-buyers, guild-joins'});
 assert.ok(!hidden.some(h=>h.id==='trader-visitor-buyers'));
 assert.ok(!hidden.some(h=>h.id==='guild-joins'));
 // The rolling mode names its own window instead of the raffle span.
 const rolling=cards({GUILDSYNC_COMMUNITY_TRADER_WINDOW:'14 days'});
 assert.match(rolling.find(h=>h.id==='trader-sales').title,/last 14 days/);
});

test('card timestamps follow the requesting viewer time zone',()=>{
 const now=RAFFLE_END-3600;
 const description=timeZone=>buildCommunityStatistics({now,timeZone})
  .highlights.find(h=>h.id==='trader-member-buyers').description;
 assert.match(description(undefined),/8:00 PM EST/);
 assert.match(description('America/Los_Angeles'),/5:00 PM PST/);
 // An unusable zone falls back to Eastern instead of breaking the report.
 assert.match(description('Not/AZone'),/EST/);
});

test('empty cards explain what is missing',()=>{
 const report=buildCommunityStatistics({now:RAFFLE_END-3600,roster:[],traderSales:[]});
 assert.ok(report.highlights.find(h=>h.id==='trader-member-buyers').emptyText.includes('No member-to-member trader sales'));
 assert.equal(report.highlights.find(h=>h.id==='discord-posts').emptyText,'No Discord posts recorded in the last 30 days.');
});
