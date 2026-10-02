import {Component,type ReactNode} from 'react';
import {recordDiagnostic} from './diagnostics';
import {ErrorGuidance} from './ErrorGuidance';
import {getAppLanguage} from './language';
const recovery={fr:'Cet écran ne peut pas être affiché. Rouvrez Zentra pour reprendre votre travail.',de:'Dieser Bildschirm kann nicht angezeigt werden. Öffnen Sie Zentra erneut, um weiterzuarbeiten.',it:'Questa schermata non può essere visualizzata. Riapri Zentra per riprendere il lavoro.',en:'This screen cannot be displayed. Reopen Zentra to continue your work.'};
type BoundaryState={failed:boolean;reason:unknown;incidentCode?:string};
export class DiagnosticBoundary extends Component<{children:ReactNode},BoundaryState>{
  state:BoundaryState={failed:false,reason:undefined};
  // Unknown JavaScript exceptions may have throwing accessors or proxy traps.
  // Preserve the value without inspecting it while React restores the screen.
  static getDerivedStateFromError(reason:unknown){return{failed:true,reason};}
  componentDidCatch(_reason:unknown){
    const id=recordDiagnostic({area:'error',operation:'client.react_render',phase:'failure',errorCode:'RENDER'});
    this.setState({incidentCode:`ZT-${id}`});
  }
  render(){
    if(!this.state.failed)return this.props.children;
    const fallback=recovery[getAppLanguage()];
    // Wait for the committed render incident before exposing its reference;
    // the first recovery render still contains a visible, static explanation.
    return <main className="splash-screen">{this.state.incidentCode
      ? <ErrorGuidance error={this.state.reason} fallback={fallback} operation="read" onReload={()=>window.location.reload()} incidentCode={this.state.incidentCode}/>
      : <p role="alert">{fallback}</p>}</main>;
  }
}
