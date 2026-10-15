"use client";
import {useEffect,useState} from 'react';
export function SharedRoles(){
 const [access,setAccess]=useState<any>(null),[error,setError]=useState('');
 async function load(){try{const response=await fetch('/api/shared-access',{cache:'no-store'});if(response.status===401){setAccess(null);return;}if(!response.ok)throw Error('Shared permissions are temporarily unavailable.');setAccess(await response.json());setError('');}catch(e){setError((e as Error).message);}}
 useEffect(()=>{void load();},[]);
 if(!access&&!error)return null;
 const role=access?.actions.includes('project.admin')?'Project administrator':access?.actions.includes('tier.partner')?'Bittrees partner':access?.actions.includes('tier.junior-partner')?'Junior partner':access?.actions.includes('tier.associate')?'Associate':'No shared role assigned';
 return <aside aria-label="Shared Bittrees permissions" style={{padding:'12px 20px',borderTop:'1px solid currentColor',fontSize:'0.85rem',display:'flex',gap:12,flexWrap:'wrap',alignItems:'center'}}><span>{error||(!access?.enrolled?'Shared roles await controller approval.':role)}</span><a href="https://roles.bittrees.org">Roles</a><a href="https://workflow.bittrees.org">Workflows</a><button onClick={()=>void load()}>Refresh permissions</button><span>Private workspace access stays with its owners.</span></aside>;
}
