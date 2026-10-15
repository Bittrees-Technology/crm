// Approved public business sources only; never fetch an arbitrary candidate URL.
const contacts: Record<string,string> = {
  'serverdepotus.com':'https://serverdepotus.com/pages/contact-us',
  'mercadominero.com.mx':'https://mercadominero.com.mx/pages/nosotros',
  'dtvelectronics.com':'https://dtvelectronics.com/contact-us/',
  'bitcoinmerch.com':'https://bitcoinmerch.com',
  'noxar.mx':'https://www.noxar.mx/pages/nosotros',
  'bitshopper.de':'https://www.bitshopper.de/en/legal-topics/privacy-and-data-protection/',
  'vilros.com':'https://vilros.com/pages/contact-us',
  'thepihut.com':'https://business.thepihut.com/',
  'shop.pimoroni.com':'https://shop.pimoroni.com/pages/contact-us',
  'miners.de':'https://miners.de/pages/contact',
};
export async function verifiedVendorContact(website:string,email:string,request:typeof fetch=fetch) {
  const u = new URL(website);
  const source = contacts[u.hostname.replace(/^www\./,'')];
  if (!source || u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  if (!email) return true; // Missing contacts remain an explicit follow-up, never fabricated.
  const response = await request(source,{redirect:'error',signal:AbortSignal.timeout(8000),cache:'no-store'});
  if (!response.ok) return false;
  const reader = response.body?.getReader();
  if (!reader) return false;
  let size=0; const chunks:Uint8Array[]=[];
  try { for (;;) { const r=await reader.read(); if(r.done)break; size+=r.value.length; if(size>1000000)return false; chunks.push(r.value); } }
  finally { await reader.cancel(); }
  const text=Buffer.concat(chunks).toString('utf8').toLowerCase();
  const emails: string[]=text.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  return emails.includes(email.toLowerCase());
}
