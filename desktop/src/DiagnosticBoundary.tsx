import {Component,type ReactNode} from 'react';
import {recordDiagnostic,resolveErrorIncident} from './diagnostics';
import {ErrorPanel} from './ui';
import {getAppLanguage} from './language';
const recovery={fr:'Cet écran ne peut pas être affiché. Rouvrez Zentra pour reprendre votre travail.',de:'Dieser Bildschirm kann nicht angezeigt werden. Öffnen Sie Zentra erneut, um weiterzuarbeiten.',it:'Questa schermata non può essere visualizzata. Riapri Zentra per riprendere il lavoro.',en:'This screen cannot be displayed. Reopen Zentra to continue your work.'};
export class DiagnosticBoundary extends Component<{children:ReactNode},{error:Error|null}>{
  state:{error:Error|null}={error:null};
  static getDerivedStateFromError(error:unknown){return{error:error instanceof Error?error:new Error('render failure')};}
  componentDidCatch(error:Error){recordDiagnostic({area:'error',operation:'client.react_render',phase:'failure',errorCode:'RENDER'});resolveErrorIncident(error);}
  render(){return this.state.error?<main className="splash-screen"><ErrorPanel message={this.state.error.message} fallback={recovery[getAppLanguage()]} operation="read" onRetry={()=>window.location.reload()}/></main>:this.props.children;}
}
