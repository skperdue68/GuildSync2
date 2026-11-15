// Pulled in here because this module is loaded once by main.js and is not part of
// the hotkey test harness, which inlines its modules and cannot resolve CSS.
import './profile-menu.css';

export function createDesktopSupport({onBlocked}) {
 let info=null;
 return {
  get blocked(){return info!==null;},get info(){return info;},
  receive(payload) {
   if(info || payload?.supported!==false)return !!info;
   let downloadUrl='';
   try{const url=new URL(payload.download_url||payload.download?.url);if(['https:','http:'].includes(url.protocol))downloadUrl=url.href;}catch{}
   info={message:String(payload.message||'This version of GuildSync is no longer supported. Install the latest version to continue.'),
    minimumVersion:String(payload.minimum_desktop_version||''),latestVersion:String(payload.latest_version||''),downloadUrl};
   onBlocked(info);return true;
  }
 };
}
