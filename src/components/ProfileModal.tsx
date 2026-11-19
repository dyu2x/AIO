import React, { useEffect, useState } from 'react';
import { UserRound, X } from 'lucide-react';
import { useCRM } from '../context/CRMContext';

interface Props { isOpen: boolean; onClose: () => void; }
export const ProfileModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { currentUser, updateMyProfile } = useCRM();
  const [name,setName]=useState(''); const [username,setUsername]=useState(''); const [email,setEmail]=useState(''); const [phone,setPhone]=useState(''); const [address,setAddress]=useState('');
  const [avatarUrl,setAvatarUrl]=useState(''); const [message,setMessage]=useState(''); const [busy,setBusy]=useState(false);
  useEffect(()=>{ if(currentUser){setName(currentUser.name||'');setUsername(currentUser.username||'');setEmail(currentUser.email||'');setPhone(currentUser.phone||'');setAddress(currentUser.address||'');setAvatarUrl(currentUser.avatar_url||'');} },[currentUser,isOpen]);
  if(!isOpen || !currentUser) return null;
  const submit=async(e:React.FormEvent)=>{e.preventDefault();setMessage('');setBusy(true);const result=await updateMyProfile({name,username,email,phone,address,avatar_url:avatarUrl});setBusy(false);setMessage(result.message||'');};
  return <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"><div className="bg-white w-full max-w-xl rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
    <div className="px-5 py-4 border-b flex items-center justify-between"><div className="flex items-center gap-2"><UserRound className="w-4 h-4"/><div><h2 className="font-semibold text-sm">My Profile</h2><p className="text-[11px] text-neutral-500">Update your CRM contact details. Identity information is managed by ZITADEL.</p></div></div><button onClick={onClose} className="p-1.5 rounded hover:bg-neutral-100"><X className="w-4 h-4"/></button></div>
    <form onSubmit={submit} className="p-5 overflow-y-auto space-y-4"><div className="flex items-center gap-4 mb-4"><img src={avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(name||'User')}`} className="w-16 h-16 rounded-full object-cover border"/><label className="text-xs font-medium">Profile avatar<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="block mt-1 text-xs" onChange={e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>2*1024*1024){setMessage('Avatar must be smaller than 2 MB.');return;}const reader=new FileReader();reader.onload=()=>setAvatarUrl(String(reader.result||''));reader.readAsDataURL(file);}}/><span className="text-[10px] text-neutral-500">PNG, JPG, WEBP or GIF · max 2 MB</span></label></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs font-medium text-neutral-700">Full name<input value={name} onChange={e=>setName(e.target.value)} className="mt-1 w-full border border-neutral-300 rounded px-3 py-2 text-sm" required /></label>
        <label className="text-xs font-medium text-neutral-700">Phone<input value={phone} onChange={e=>setPhone(e.target.value)} className="mt-1 w-full border border-neutral-300 rounded px-3 py-2 text-sm" /></label>
        <label className="text-xs font-medium text-neutral-700">Username (managed by ZITADEL)<input value={username} readOnly disabled className="mt-1 w-full border border-neutral-300 rounded px-3 py-2 text-sm bg-neutral-100 text-neutral-500 cursor-not-allowed" /></label>
        <label className="text-xs font-medium text-neutral-700">Email (managed by ZITADEL)<input value={email} readOnly disabled type="email" className="mt-1 w-full border border-neutral-300 rounded px-3 py-2 text-sm bg-neutral-100 text-neutral-500 cursor-not-allowed" /></label>
      </div>
      <label className="block text-xs font-medium text-neutral-700">Address<input value={address} onChange={e=>setAddress(e.target.value)} className="mt-1 w-full border border-neutral-300 rounded px-3 py-2 text-sm"/></label>
      <p className="text-xs text-neutral-500 border-t pt-3">To change your username or email address, update your ZITADEL profile. The CRM will synchronize those identity details on your next sign-in.</p>
      {message&&<p className={`text-xs rounded p-2 ${message.toLowerCase().includes('success')?'bg-emerald-50 text-emerald-700':'bg-amber-50 text-amber-800'}`}>{message}</p>}
      <div className="flex justify-end gap-2 pt-2"><button type="button" onClick={onClose} className="px-3 py-2 border rounded text-xs">Close</button><button disabled={busy} className="px-4 py-2 rounded bg-neutral-900 text-white text-xs disabled:opacity-50">{busy?'Saving…':'Save profile'}</button></div>
    </form>
  </div></div>;
};
