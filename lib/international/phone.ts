import type {CountryCode} from './types';

/** Syntax/format only. +1 belongs to the NANP, not exclusively the United States. */
export function normalizeContactPhone(value:string,localDialingCountry:CountryCode):string {
 if(typeof value!=='string'||value.length>64||!value.trim()||!['CH','US'].includes(localDialingCountry)||!/^\+?[0-9 ().-]+$/.test(value)) throw new TypeError('Invalid contact phone format');
 const compact=value.replace(/[ ().-]/g,'');
 if(compact.startsWith('+')) {if(!/^\+[1-9][0-9]{5,14}$/.test(compact)) throw new TypeError('Invalid international phone format');return compact;}
 const adapters={US:(digits:string)=>{const national=digits.length===11&&digits.startsWith('1')?digits.slice(1):digits;if(!/^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(national))throw new TypeError('Enter a ten-digit NANP phone number or an explicit international number');return '+1'+national;},CH:(digits:string)=>{const national=digits.startsWith('0')?digits.slice(1):digits;if(!/^[1-9][0-9]{8}$/.test(national))throw new TypeError('Enter a Swiss national phone number or an explicit international number');return '+41'+national;}};
 return adapters[localDialingCountry](compact);
}
export function formatContactPhone(canonical:string,displayCountry:CountryCode):string {
 if(!/^\+[1-9][0-9]{5,14}$/.test(canonical)) throw new TypeError('Canonical international phone required');
 if(displayCountry==='US'&&/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/.test(canonical)) return `+1 (${canonical.slice(2,5)}) ${canonical.slice(5,8)}-${canonical.slice(8)}`;
 if(displayCountry==='CH'&&/^\+41[1-9][0-9]{8}$/.test(canonical)) return `+41 ${canonical.slice(3,5)} ${canonical.slice(5,8)} ${canonical.slice(8,10)} ${canonical.slice(10)}`;
 if(displayCountry!=='CH'&&displayCountry!=='US')throw new TypeError('Unsupported display country');
 return canonical;
}
