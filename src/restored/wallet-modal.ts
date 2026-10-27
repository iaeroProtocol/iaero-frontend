import {usePreview} from '../store';
export function useConnectModal(){const s=usePreview();return {openConnectModal:()=>s.setWalletDialog(true)};}
