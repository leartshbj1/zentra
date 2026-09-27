import {useId,useState} from 'react';
import {Sun,Moon,Monitor,Check} from 'lucide-react';
import {useAppearance,setAppearance,type Appearance} from './appearance';
import {t,useAppLanguage} from './language';
import {useTextSize,setTextSize,type TextSize} from './textSize';
import './appearance.css';
export function AppearanceSetting({compact=false,embedded=false}:{compact?:boolean;embedded?:boolean}){
 useAppLanguage();const current=useAppearance(),[saved,setSaved]=useState<boolean|null>(null);
 const size=useTextSize(),sizeId=useId(),[sizeSaved,setSizeSaved]=useState<boolean|null>(null);
 return <section className={`appearance-setting${compact?' appearance-setting--compact':''}`} aria-label={t('Apparence de l’application')}>
 {!embedded&&<><h2>{t('Un confort adapté à votre journée')}</h2><p>{t('Choisissez un fond clair, un fond sombre ou suivez le réglage de votre appareil.')}</p></>}
 <div className="appearance-choices" role="group" aria-label={t('Apparence de l’application')}>
 {([['light','Clair',Sun],['dark','Sombre',Moon],['system','Automatique',Monitor]] as const).map(([value,label,Icon])=><button key={value} type="button" aria-pressed={current===value} onClick={()=>setSaved(setAppearance(value as Appearance))}><span className={`appearance-sample appearance-sample--${value}`} aria-hidden="true"><i/><b/><b/><b/></span><span><Icon size={17}/>{t(label)}{current===value&&<Check size={16}/>}</span></button>)}
 </div>{!compact&&<p>{t('Votre choix est enregistré sur cet appareil. Les factures, devis et documents conservent leurs couleurs d’impression.')}</p>}
 {saved===false&&<p role="alert">{t('Le thème est appliqué pour cette session, mais votre préférence n’a pas pu être enregistrée.')}</p>}
 <div className="text-size-setting">
  <div className="text-size-setting__heading"><label htmlFor={sizeId}>{t('Taille du texte')}</label><output htmlFor={sizeId}>{size} %</output></div>
  <input id={sizeId} type="range" min="100" max="200" step="25" value={size} aria-valuetext={`${size} %`} aria-describedby={`${sizeId}-help`} onChange={event=>setSizeSaved(setTextSize(Number(event.target.value) as TextSize))}/>
  <p id={`${sizeId}-help`}>{t('Ajustez la lecture sur cet appareil. Vos documents gardent leur mise en page.')}</p>
  {size!==100&&<button type="button" className="text-size-setting__reset" onClick={()=>setSizeSaved(setTextSize(100))}>{t('Revenir à 100 %')}</button>}
  {sizeSaved===false&&<p role="alert">{t('La taille est appliquée pour cette session, mais n’a pas pu être enregistrée.')}</p>}
 </div>
 </section>;
}
