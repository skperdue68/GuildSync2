import {randomUUID} from 'node:crypto';
import {membershipDMMessage} from './membership-dms.js';

// Sends simulated membership DMs to the officer who starts test mode. Every message is
// rendered from the live template for one real unlinked member, but only the officer
// receives it and no backend state, history or response row is touched.
export function createMembershipDMTestMode({client,guildId,request,log=console.log,intervalMs=30000,setIntervalFn=setInterval,clearIntervalFn=clearInterval}={}) {
  let session=null;
  const isRunning=()=>Boolean(session);
  function status(){return session?{running:true,actorId:session.actorId,sent:session.sent,members:session.members,lastMember:session.lastMember||null,nextAt:session.nextAt||null}:{running:false};}
  function stop(){
    if(!session)return false;
    clearIntervalFn(session.timer);
    session=null;
    return true;
  }
  async function deliverOne(){
    if(!session)return {status:'stopped'};
    if(!client.isReady?.())return {status:'not-ready'};
    const plan=await request('test-plan',{actorId:session.actorId});
    const members=plan?.members||[];
    if(!members.length)return {status:'empty'};
    const position=(session.index%members.length)+1;
    const member=members[position-1];
    session.index+=1;
    const job={id:randomUUID(),campaignId:'test-mode',userId:member.userId,name:member.name,isTest:true,simulated:true};
    const guild=await client.guilds.fetch(guildId);
    const user=await client.users.fetch(session.actorId);
    const message=await user.send(membershipDMMessage(job,plan.config,{name:member.name,guildName:guild.name,position,total:members.length}));
    session.sent+=1;
    session.lastMember=member.name;
    log(`Membership DM test mode ${position}/${members.length}: would have sent to ${member.name} (${member.userId}).`);
    return {status:'sent',member,position,total:members.length,messageId:message?.id};
  }
  function start(actorId,{members=0}={}){
    stop();
    session={actorId,index:0,sent:0,members,startedAt:Date.now()};
    session.timer=setIntervalFn(()=>{deliverOne().catch(error=>log('Membership DM test mode: '+error.message));},intervalMs);
    session.timer?.unref?.();
    return {intervalMs,members};
  }
  return {start,stop,deliverOne,isRunning,status};
}
