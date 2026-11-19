import React from 'react';
import { Lock, ShieldCheck, AlertCircle } from 'lucide-react';
import { useCRM } from '../context/CRMContext';

export const LoginPage: React.FC = () => {
  const { branding } = useCRM();
  const authError = new URLSearchParams(window.location.search).get('auth_error') === 'zitadel';
  const initialLetter = (branding.company_name || 'Mesina Farms').trim().charAt(0).toUpperCase();

  return (
    <div className="min-h-screen w-full flex flex-col md:flex-row font-sans selection:bg-neutral-800 selection:text-white bg-black">
      <div className="login-scenic-panel relative isolate w-full md:w-1/2 text-white p-8 md:p-16 flex flex-col justify-between min-h-[380px] md:min-h-screen border-b md:border-b-0 md:border-r border-neutral-900" style={{backgroundImage:`linear-gradient(90deg,rgba(0,0,0,.62),rgba(0,0,0,.18)),url("${branding.login_background_image === undefined ? '/login-golden-gate.png' : branding.login_background_image}")`}}>
        <div className="flex items-center gap-3">
          {branding.company_logo ? <img src={branding.company_logo} alt={branding.company_name} className="w-7 h-7 object-contain rounded" /> : <div className="w-6 h-6 flex items-center justify-center text-sm font-semibold text-white tracking-wider">{initialLetter}</div>}
          <span className="font-medium text-sm md:text-base tracking-normal text-neutral-100">{branding.company_name || 'Mesina Farms'}</span>
        </div>
        <div className="py-12 md:py-0 max-w-lg">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-white leading-[1.15]">{branding.tagline || <>Orders, deliveries and<br />follow-ups in one place.</>}</h1>
          <p className="text-neutral-400 text-sm md:text-base mt-4 font-normal leading-relaxed">{branding.subtitle || 'Track every farm from first order to collected payment.'}</p>
        </div>
      </div>
      <div className="w-full md:w-1/2 bg-white flex items-center justify-center p-6 sm:p-12 md:p-16">
        <div className="w-full max-w-[360px] mx-auto">
          <div className="mb-6"><div className="w-10 h-10 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-800"><Lock className="w-4 h-4 text-neutral-700" strokeWidth={2.2} /></div></div>
          <h2 className="text-2xl font-bold text-neutral-900 tracking-tight">{branding.login_heading || 'Welcome back'}</h2>
          <p className="text-xs sm:text-sm text-neutral-500 mt-1 mb-8">{branding.login_description && !/username|password/i.test(branding.login_description) ? branding.login_description : 'Sign in securely with your Mesina Farms identity account.'}</p>
          {authError && <div className="mb-6 p-3 rounded-md bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-700"><AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" /><span>We could not complete your ZITADEL sign-in. Please try again or contact your administrator.</span></div>}
          <button type="button" onClick={() => { window.location.assign('/api/auth/zitadel'); }} className="w-full mt-2 py-3 px-4 bg-black hover:bg-neutral-800 text-white font-medium rounded-md text-sm transition focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 cursor-pointer shadow-xs flex items-center justify-center gap-2">
            <ShieldCheck className="w-4 h-4" /> Continue with ZITADEL
          </button>
          <p className="mt-8 text-xs text-neutral-500 text-center leading-normal">Authentication is securely managed by Mesina Farms identity services.</p>
          {branding.login_footer && <p className="text-[11px] text-neutral-400 text-center mt-6">{branding.login_footer}</p>}
        </div>
      </div>
    </div>
  );
};
