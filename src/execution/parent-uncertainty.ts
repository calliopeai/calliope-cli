/** Preserve project reservations when a parent may have accepted the charge. */
const uncertain=new WeakSet<Error>();
export function markParentAdmissionUncertain(error:unknown):void {if(error instanceof Error)uncertain.add(error);}
export function parentAdmissionUncertain(error:unknown):boolean {return error instanceof Error&&uncertain.has(error);}
