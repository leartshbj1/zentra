import {useEffect, useRef, useState} from 'react';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {Button} from './ui';
import {t} from './language';
import './collection-pagination.css';

export function useCollectionPage<T>(items: readonly T[], key: string, size: number) {
  const [selection,setSelection]=useState({key,page:0});
  const startRef=useRef<HTMLDivElement>(null);
  const pageCount=Math.max(1,Math.ceil(items.length/size));
  const page=selection.key===key?Math.min(selection.page,pageCount-1):0;
  // Commit a reset or clamp so an old page cannot reappear after a filter or
  // synchronization temporarily reduces the collection.
  useEffect(()=>{
    if(selection.key!==key||selection.page!==page)setSelection({key,page});
  },[key,page,selection.key,selection.page]);
  const changePage=(next:number)=>{
    setSelection({key,page:Math.max(0,Math.min(next,pageCount-1))});
    requestAnimationFrame(()=>{
      startRef.current?.scrollIntoView({block:'start'});
      startRef.current?.focus({preventScroll:true});
    });
  };
  return {page,pageCount,start:page*size+1,end:Math.min((page+1)*size,items.length),total:items.length,items:items.slice(page*size,(page+1)*size),changePage,startRef};
}

type Pagination = Pick<ReturnType<typeof useCollectionPage>, 'page'|'pageCount'|'start'|'end'|'total'|'changePage'>;
export function CollectionPagination({pagination,label,announce=true}:{pagination:Pagination;label:string;announce?:boolean}){
  if(pagination.pageCount<=1)return null;
  return <nav className="collection-pagination" aria-label={label}>
    <Button variant="secondary" onClick={()=>pagination.changePage(pagination.page-1)} disabled={pagination.page===0} aria-label={t('Page précédente')}>
      <ChevronLeft size={16} aria-hidden="true"/><span className="collection-pagination__label">{t('Précédent')}</span>
    </Button>
    <span role={announce?'status':undefined} aria-atomic={announce?true:undefined}>{t('{start}–{end} sur {total}',{start:pagination.start,end:pagination.end,total:pagination.total})}</span>
    <Button variant="secondary" onClick={()=>pagination.changePage(pagination.page+1)} disabled={pagination.page+1===pagination.pageCount} aria-label={t('Page suivante')}>
      <span className="collection-pagination__label">{t('Suivant')}</span><ChevronRight size={16} aria-hidden="true"/>
    </Button>
  </nav>;
}
