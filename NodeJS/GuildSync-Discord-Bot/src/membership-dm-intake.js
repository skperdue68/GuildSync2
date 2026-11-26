import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// A saved answer and the Discord outcome it produced share the same Discord event
// ID, so the outcome gets its own key instead of overwriting the answer.
export function membershipIntakeKey(event) {
  return String(event?.payload?.eventId??'')+(event?.kind==='outcome'?'-outcome':'');
}

export function createMemoryDMIntake() {
  const events=new Map();
  return {async put(event){events.set(membershipIntakeKey(event),event);},async list(){return [...events.values()];},async remove(id){events.delete(id);}};
}

// One restricted local file per incoming Discord event. A backend restart must
// not lose replies already received by the bot; server event IDs deduplicate replay.
export function createFileDMIntake(directory) {
  const root=path.resolve(directory);
  const file=id=>{if(!/^\d+(-outcome)?$/.test(String(id)))throw Error('Invalid Discord intake event ID.');return path.join(root,String(id)+'.json');};
  return {
    async put(event){
      await fs.mkdir(root,{recursive:true,mode:0o700});
      const destination=file(membershipIntakeKey(event)),temporary=destination+'.'+randomUUID()+'.tmp';
      try{
        const handle=await fs.open(temporary,'wx',0o600);
        try{await handle.writeFile(JSON.stringify(event));await handle.sync();}finally{await handle.close();}
        await fs.rename(temporary,destination);
      }
      finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    },
    async list(){
      let names;
      try{names=await fs.readdir(root);}catch(error){if(error.code==='ENOENT')return [];throw error;}
      const events=[];
      for(const name of names.filter(name=>/^\d+(-outcome)?\.json$/.test(name)).sort().slice(0,250))events.push(JSON.parse(await fs.readFile(path.join(root,name),'utf8')));
      return events;
    },
    async remove(id){await fs.unlink(file(id)).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  };
}
