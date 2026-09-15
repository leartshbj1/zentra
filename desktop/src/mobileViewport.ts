/** Keep the app shell at device width. Documents retain their own touch zoom. */
export function installMobileViewport() {
  const query=window.matchMedia('(max-width: 860px), (pointer: coarse) and (max-height: 500px)');
  const viewport=document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const previous=viewport?.content;
  const documentTarget=(target:EventTarget|null)=>target instanceof Element&&Boolean(target.closest('[data-touch-document]'));
  const update=()=>{
    document.documentElement.classList.toggle('mobile-viewport-fixed',query.matches);
    if(viewport) viewport.content=query.matches
      ? 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content'
      : previous ?? 'width=device-width, initial-scale=1, viewport-fit=cover';
  };
  const gesture=(event:Event)=>{if(query.matches&&!documentTarget(event.target)&&event.cancelable)event.preventDefault();};
  const touch=(event:TouchEvent)=>{if(event.touches.length>1)gesture(event);};
  const wheel=(event:WheelEvent)=>{if(event.ctrlKey)gesture(event);};
  query.addEventListener('change',update); update();
  document.addEventListener('gesturestart',gesture,{passive:false});
  document.addEventListener('gesturechange',gesture,{passive:false});
  document.addEventListener('touchmove',touch,{passive:false});
  document.addEventListener('dblclick',gesture,{passive:false});
  document.addEventListener('wheel',wheel,{passive:false});
  return ()=>{
    query.removeEventListener('change',update);
    document.removeEventListener('gesturestart',gesture);document.removeEventListener('gesturechange',gesture);
    document.removeEventListener('touchmove',touch);document.removeEventListener('dblclick',gesture);document.removeEventListener('wheel',wheel);
    document.documentElement.classList.remove('mobile-viewport-fixed');
    if(viewport&&previous!==undefined)viewport.content=previous;
  };
}
