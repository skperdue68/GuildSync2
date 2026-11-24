export const DEFAULT_MEMBERSHIP_DM='Hello {name}! We could not find an ESO account linked to your Discord account for {guild}. Please choose an option below, or type a reply.';
export function dmConfig(env={}) {
  const get=(key,fallback='')=>String(env['GUILDSYNC_MEMBERSHIP_DM_'+key]??fallback).trim();
  const enabled=get('ENABLED','false');
  if(!['true','false'].includes(enabled))throw Error('Membership DM enabled must be true or false.');
  const repeatDays=Number(get('REPEAT_DAYS','30'));
  if(!Number.isInteger(repeatDays)||repeatDays<1||repeatDays>365)throw Error('Membership DM repeat interval must be 1–365 whole days.');
  const destinationType=get('DESTINATION_TYPE','channel'),destinationId=get('DESTINATION_ID'),communityRoleId=get('COMMUNITY_ROLE_ID');
  if(!['channel','user'].includes(destinationType))throw Error('Choose a user or channel reply destination.');
  for(const id of [destinationId,communityRoleId])if(id&&!/^\d+$/.test(id))throw Error('Membership DM destinations and roles must use Discord IDs.');
  if(enabled==='true'&&!destinationId)throw Error('Configure a reply destination before enabling membership DMs.');
  const template=get('MESSAGE')||DEFAULT_MEMBERSHIP_DM;
  if(template.length>1500)throw Error('Membership DM template must be at most 1500 characters.');
  for(const match of template.matchAll(/\{([^{}]+)\}/g))if(!['name','guild'].includes(match[1]))throw Error('Unknown membership DM placeholder: '+match[1]);
  return {enabled:enabled==='true',repeatDays,destinationType,destinationId,communityRoleId,template};
}
