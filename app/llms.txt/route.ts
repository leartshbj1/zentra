import { absoluteSiteUrl } from '@/lib/site-url';
import { homeQuestions } from '@/lib/seo';

// Optional reading aid. Public HTML remains the authoritative content.
export function GET() {
  const links = [
    ['/gestion', 'Zentra Gestion : gestion des PME suisses'],
    ['/features', 'Fonctionnalités et limites de Gestion'],
    ['/pricing', 'Tarifs Gestion'],
    ['/download', 'Téléchargements et versions disponibles'],
    ['/support', 'Zentra Support : classement des tickets clients'],
    ['/support/connexions', 'Connexions Support et conditions de disponibilité'],
    ['/support/tarifs', 'Tarifs Support'],
    ['/automation', 'Zentra Automation : option de Gestion'],
    ['/security', 'Sécurité et données'],
    ['/mentions-legales', 'Éditeur et contact'],
  ];
  const text = [
    '# Zentra',
    '> Logiciels de gestion et de service client pour les PME suisses.',
    'Site officiel : ' + absoluteSiteUrl('/'),
    'Contact : info@zentraapp.ch. Langue : français (Suisse).',
    '## Produits et informations officielles',
    ...links.map(([path, label]) => `- [${label}](${absoluteSiteUrl(path)})`),
    '## Questions fréquentes',
    ...homeQuestions.map(({ question, answer }) => `### ${question}\n${answer}`),
    'Les pages publiques liées ci-dessus font référence pour les tarifs, les versions, les connexions disponibles et les limites du produit.',
  ].join('\n\n');
  return new Response(text + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
