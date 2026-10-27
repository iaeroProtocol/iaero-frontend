import type {ButtonHTMLAttributes} from 'react';
import {cn} from '@/lib/utils';
export function Button({className,variant='default',size, ...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string;size?:string}){return <button {...props} className={cn('rift-button',variant==='outline'?'rift-button-outline':'',size==='sm'?'rift-button-small':'',className)}/>;}
