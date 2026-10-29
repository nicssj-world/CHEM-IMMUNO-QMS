'use client';

import { useId, useRef } from 'react';
import { Search, X } from 'lucide-react';

type SearchInputProps = {
 label:string;
 placeholder:string;
 value:string;
 onChange:(value:string)=>void;
};
/** Shared accessible input: explicit icon spacing prevents .input's base padding from covering text. */
export function SearchInput({label,placeholder,value,onChange}:SearchInputProps) {
 const id=useId();
 const inputRef=useRef<HTMLInputElement>(null);
 function clear(){
  onChange('');
  inputRef.current?.focus();
 }
 return <div className="field">
   <label htmlFor={id}>{label}</label>
   <div className="ci-search-wrap">
     <Search size={18} aria-hidden="true" className="ci-search-icon"/>
     <input id={id} ref={inputRef} className="input ci-search-input"
       type="search" autoComplete="off" value={value} placeholder={placeholder}
       onChange={event=>onChange(event.target.value)}
       onKeyDown={event=>{if(event.key==='Escape'&&value){event.preventDefault();clear();}}}/>
     {value.length>0&&<button type="button" className="ci-search-clear"
       aria-label="ล้างคำค้นหา" title="ล้างคำค้นหา" onClick={clear}>
       <X size={18} aria-hidden="true"/>
     </button>}
   </div>
 </div>;
}
