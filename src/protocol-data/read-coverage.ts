import policy from '../../config/frontend-read-policy.json' with {type:'json'};
export type ReadCoverage={provider:string;providers:number;singleProviderAccepted:boolean;independentlyVerified:boolean;independentLaunchProvidersRequired:number};
export function readCoverage(providers:number):ReadCoverage{return {provider:providers===1?'Alchemy':'Independent providers',providers,singleProviderAccepted:providers===1&&policy.singleAlchemyApproved,independentlyVerified:providers>=2,independentLaunchProvidersRequired:policy.independentLaunchProvidersRequired};}
export function acceptedReadCoverage(providers:unknown,coverage?:Partial<ReadCoverage>){return providers===2||providers===1&&policy.singleAlchemyApproved&&coverage?.provider==='Alchemy'&&coverage.singleProviderAccepted===true;}
