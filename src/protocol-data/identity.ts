import registry from '../../config/base.registry.json' with {type:'json'};
import policy from '../../config/protocol-yield.json' with {type:'json'};
export const expectedYieldPosition=registry.chainId+':'+registry.aero.votingEscrow.toLowerCase()+':'+policy.positionId;
