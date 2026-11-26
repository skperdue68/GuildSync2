import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFileDMIntake,membershipIntakeKey} from './membership-dm-intake.js';
test('incoming replies survive a worker restart and replay can remove them safely',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gs-dm-intake-'));
 try{
  const event={guildId:'1',payload:{eventId:'123',userId:'10',text:'Response'}};
  await createFileDMIntake(directory).put(event);
  const restarted=createFileDMIntake(directory);assert.deepEqual(await restarted.list(),[event]);
  await restarted.remove('123');await restarted.remove('123');assert.deepEqual(await restarted.list(),[]);
  await assert.rejects(()=>restarted.put({payload:{eventId:'../outside'}}),/Invalid/);
  // The saved answer and the Discord outcome it produced share an event ID.
  const answer={guildId:'1',payload:{eventId:'55',choice:'remove'}};
  const outcome={guildId:'1',kind:'outcome',payload:{eventId:'55',removal:{status:'kicked'}}};
  const both=createFileDMIntake(directory);
  await both.put(answer);await both.put(outcome);
  assert.deepEqual((await both.list()).map(membershipIntakeKey).sort(),['55','55-outcome'].sort());
  await both.remove(membershipIntakeKey(outcome));
  assert.deepEqual(await both.list(),[answer]);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
