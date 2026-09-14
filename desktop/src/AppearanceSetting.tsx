import {useState} from 'react';
import {Sun,Moon,Monitor,Check} from 'lucide-react';
import {useAppearance,setAppearance,type Appearance} from './appearance';
import {t,useAppLanguage} from './language';
import './appearance.css';
export function AppearanceSetting({compact=false}:{compact?:boolean}){
 useAppLanguage();const current=useAppearance(),[saved,setSaved]=useState<boolean|null>(null);
 return <section className={`appearance-setting${compact?' appearance-setting--compact':''}`} aria-label={t('Apparence de l’application')}>
 <h2>{t('Un confort adapté à votre journée')}</h2><p>{t('Choisissez un fond clair, un fond sombre ou suivez le réglage de votre appareil.')}</p>
 <div className="appearance-choices" role="group" aria-label={t('Apparence de l’application')}>
 {([['light','Clair',Sun],['dark','Sombre',Moon],['system','Automatique',Monitor]] as const).map(([value,label,Icon])=><button key={value} type="button" aria-pressed={current===value} onClick={()=>setSaved(setAppearance(value as Appearance))}><span className={`appearance-sample appearance-sample--${value}`} aria-hidden="true"><i/><b/><b/><b/></span><span><Icon size={17}/>{t(label)}{current===value&&<Check size={16}/>}</span></button>)}
 </div>{!compact&&<p>{t('Votre choix est enregistré sur cet appareil. Les factures, devis et documents conservent leurs couleurs d’impression.')}</p>}
 {saved===false&&<p role="alert">{t('Le thème est appliqué pour cette session, mais votre préférence n’a pas pu être enregistrée.')}</p>}
 </section>;
}
