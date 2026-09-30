import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ProductHero, ProductDetails } from '@/components/quiet-product';
import { StructuredData } from '@/components/structured-data';
import { homeQuestions, faqData } from '@/lib/seo';

export const metadata = {
  title: 'Questions fréquentes',
  description: 'Choisir son produit, travailler en équipe et retrouver ses données : les réponses essentielles sur Zentra.',
  alternates: { canonical: '/questions' },
};

export default function QuestionsPage() {
  return <div className="quiet-site quiet-questions">
    <a href="#contenu" className="site-skip-link">Aller au contenu</a>
    <StructuredData data={faqData('/questions')} />
    <SiteHeader />
    <main id="contenu" tabIndex={-1}>
      <ProductHero title={<>Tout comprendre.<br /><span>Simplement.</span></>}
        description="Les réponses utiles pour trouver votre place dans Zentra."
        href="#reponses" action="Voir les réponses" />
      <ProductDetails title="Vos questions." id="reponses">
        {homeQuestions.map(({ question, answer, href, label }) => <details key={question}><summary>{question}</summary><p>{answer}</p><a className="quiet-link" href={href}>{label}</a></details>)}
      </ProductDetails>
      <section className="quiet-offer quiet-width"><div><h2>Une autre question ?</h2><p>Écrivez-nous.</p></div><a className="quiet-primary" href="mailto:info@zentraapp.ch">Contacter Zentra</a></section>
    </main>
    <SiteFooter />
  </div>;
}
