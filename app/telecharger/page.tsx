import { ArrowLeft, Check, Download, FileArchive, HardDrive, HardHat, Laptop, ShieldAlert, ShieldCheck, WifiOff } from 'lucide-react';
import { PurchaseButton } from '@/components/purchase-button';

export const metadata = {
  title: 'Télécharger HelviChantier pour Windows',
  description: 'Téléchargez le véritable installateur Windows .exe multisectoriel de HelviChantier.',
  openGraph: {
    title: 'Télécharger HelviChantier pour Windows',
    description: 'Installateur Windows x64, données métier locales et questionnaire obligatoire au premier lancement.',
  },
  twitter: {
    title: 'Télécharger HelviChantier pour Windows',
    description: 'Installateur Windows x64, données métier locales et questionnaire obligatoire au premier lancement.',
  },
};

const installerPath = '/downloads/HelviChantier_1.0.0_x64-setup.exe';

export default function DownloadPage() {
  return (
    <main className="min-h-screen bg-[#f4f2ed] text-[#17231d]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 lg:px-8">
        <a href="/" className="flex items-center gap-2.5"><span className="grid size-9 place-items-center rounded-xl bg-[#173d2c] text-[#efaa3c]"><HardHat className="size-5" /></span><span className="font-semibold tracking-[-.03em]">HelviChantier</span></a>
        <a href="/" className="flex items-center gap-2 text-sm text-[#637068]"><ArrowLeft className="size-4" /> Retour au site</a>
      </header>

      <section className="mx-auto grid max-w-6xl gap-12 px-5 pb-20 pt-14 lg:grid-cols-[.9fr_1.1fr] lg:items-center lg:px-8 lg:pt-24">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9b651e]">Application Windows 64 bits</p>
          <h1 className="mt-4 text-5xl font-semibold leading-[1.02] tracking-[-.055em] sm:text-6xl">Un vrai logiciel.<br /><span className="text-[#b86b16]">Un vrai installateur.</span></h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-[#67716a]">Téléchargez le fichier `.exe`, installez HelviChantier puis renseignez votre entreprise et son activité. La première base contient exactement zéro client, zéro projet, zéro chantier et zéro montant.</p>
          <div className="mt-8 max-w-md"><PurchaseButton /></div>
          <a href={installerPath} download className="mt-4 inline-flex h-13 items-center justify-center gap-3 rounded-full border border-[#b8b3a8] bg-white px-7 text-sm font-semibold text-[#173d2c] hover:bg-[#fffdf8]"><Download className="size-5" /> Télécharger HelviChantier 1.0.0</a>
          <div className="mt-5 space-y-1 text-xs leading-5 text-[#7f8781]"><p>Format : installateur Windows `.exe` · application x64 · 2,05 Mio</p><p>Compatibilité : Windows 10 et Windows 11</p><p>SHA-256 : <code className="break-all">D8079645E30A53314FC5FBE662CD5EBBE3778A9AD729DDB16A3A24DE5C78EBF6</code> · <a className="underline underline-offset-2" href={`${installerPath}.sha256.txt`}>fichier de contrôle</a></p><p>Tarif encaissé par Stripe : 50 CHF par mois</p></div>
          <div className="mt-5 flex max-w-xl items-start gap-3 rounded-2xl border border-[#d8aa67] bg-[#fff6e8] p-4 text-sm leading-6 text-[#76501e]">
            <ShieldAlert className="mt-0.5 size-5 shrink-0" />
            <p><strong>Signature Windows en attente.</strong> La licence applicative est vérifiée cryptographiquement, mais cette version n’a pas encore de signature d’éditeur Authenticode : SmartScreen peut avertir ou bloquer l’installateur.</p>
          </div>
        </div>

        <div className="rounded-[30px] bg-[#173d2c] p-6 text-white shadow-[0_35px_90px_rgba(26,49,35,.18)] sm:p-8">
          <div className="grid gap-3 sm:grid-cols-2">{[
            { icon: Laptop, title: 'Application de bureau', text: 'Sa propre fenêtre Windows, sans onglet de navigateur.' },
            { icon: HardDrive, title: 'Données sur le PC', text: 'La base et les sauvegardes restent chez le client.' },
            { icon: WifiOff, title: 'Fonctionnement hors ligne', text: 'La gestion métier ne dépend pas d’Internet.' },
            { icon: FileArchive, title: 'Sauvegarde exportable', text: 'Créez et restaurez un fichier de sauvegarde local.' },
          ].map(({ icon: Icon, title, text }) => <div key={title} className="rounded-2xl bg-white/8 p-4"><Icon className="size-5 text-[#efaa3c]" /><h2 className="mt-4 text-sm font-semibold">{title}</h2><p className="mt-2 text-xs leading-5 text-white/55">{text}</p></div>)}</div>
          <div className="mt-6 rounded-2xl border border-white/10 p-5"><div className="flex items-center gap-3"><ShieldCheck className="size-5 text-[#efaa3c]" /><h2 className="font-semibold">Ce qui se passe au premier lancement</h2></div><ul className="mt-4 space-y-3 text-sm text-white/65">{['Identifiant d’installation local affiché pour l’activation', 'Jeton Stripe signé et lié à un seul PC', 'Choix entre créer l’entreprise ou restaurer une sauvegarde', 'Choix obligatoire du secteur, de la division NOGA 2025 et de l’activité précise', 'Questionnaire identité, facturation, temps, paie et sauvegarde', 'Tableau de bord vide jusqu’à la première vraie saisie'].map((item) => <li key={item} className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0 text-[#efaa3c]" /> {item}</li>)}</ul></div>
        </div>
      </section>

      <section className="border-t border-[#d9d4c9] bg-white/55 px-5 py-14 lg:px-8"><div className="mx-auto max-w-6xl"><h2 className="text-2xl font-semibold tracking-tight">Installation en trois étapes</h2><div className="mt-8 grid gap-4 md:grid-cols-3">{[['1', 'Télécharger', 'Enregistrez le fichier .exe depuis le bouton ci-dessus.'], ['2', 'Installer', 'Ouvrez le fichier et suivez l’assistant Windows.'], ['3', 'Configurer', 'Lancez HelviChantier et complétez le questionnaire obligatoire.']].map(([n, title, text]) => <div key={n} className="rounded-2xl border border-[#ded9ce] bg-white p-5"><span className="text-xs font-bold text-[#b86b16]">ÉTAPE {n}</span><h3 className="mt-5 font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-[#707a72]">{text}</p></div>)}</div><p className="mt-8 text-sm text-[#707a72]">Besoin d’aide ou d’une licence ? <a className="font-semibold text-[#315e48] underline underline-offset-4" href="mailto:leartshabija@gmail.com?subject=HelviChantier%20-%20installation">leartshabija@gmail.com</a></p></div></section>
    </main>
  );
}
