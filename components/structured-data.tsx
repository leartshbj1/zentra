import { serializeStructuredData } from '@/lib/seo';
import { currentSiteLanguage } from '@/lib/site-language-server';
import { siteDictionary, translateSiteStructuredData } from '@/lib/site-copy';

export function StructuredData({ data }: { data: unknown }) {
  const language=currentSiteLanguage();
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeStructuredData(translateSiteStructuredData(data,language,siteDictionary(language))) }} />;
}
