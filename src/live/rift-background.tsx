import {useEffect,useState} from 'react';
import {AsyncSection,RecoveryControls} from '../async-section';
import {usePreview} from '../store';
const loadWatcher=()=>import('../restored/components/rift/OrderWatcher');
export function RiftBackground(){const s=usePreview(),[hasOrders,setHasOrders]=useState(false);useEffect(()=>{const read=()=>{try{const orders=JSON.parse(localStorage.getItem('iaero.rift.orders.v1')??'[]');setHasOrders(Array.isArray(orders)&&orders.length>0);}catch{}};read();window.addEventListener('iaero-rift-orders',read);window.addEventListener('storage',read);return()=>{window.removeEventListener('iaero-rift-orders',read);window.removeEventListener('storage',read);};},[]);return hasOrders?<AsyncSection name="Saved order tracking" loader={loadWatcher} componentProps={{showToast:(m:string)=>s.notify(m)}} renderError={retry=><div className="background-recovery"><RecoveryControls name="Saved order tracking" retry={retry}/></div>}/>:null;}
