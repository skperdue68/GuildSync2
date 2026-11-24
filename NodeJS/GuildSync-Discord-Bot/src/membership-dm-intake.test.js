import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFileDMIntake} from './membership-dm-intake.js';
test('incoming replies survive a worker restart and replay can remove them safely',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gs-dm-intake-'));
 try{
  const event={guildId:'1',payload:{eventId:'123',userId:'10',text:'Response'}};
  await createFileDMIntake(directory).put(event);
  const restarted=createFileDMIntake(directory);assert.deepEqual(await restarted.list(),[event]);
  await restarted.remove('123');await restarted.remove('123');assert.deepEqual(await restarted.list(),[]);
  await assert.rejects(()=>restarted.put({payload:{eventId:'../outside'}}),/Invalid/);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
