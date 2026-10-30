import { RotateCcw, TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeError, logClientError } from "../lib/logError";

interface Props {
  /** Shown in the message and in the log ("Anuncios", "Analista"...). */
  name: string;
  children: ReactNode;
}

interface State {
  error: unknown;
}

/**
 * A render error in one section must not blank the whole window: it shows a friendly message with a retry button
 * and writes the error (with the component stack) to the application log.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error("Error desconocido") };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    logClientError("render", error, `${this.props.name}${info.componentStack ? ` ${info.componentStack.replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    const { message } = describeError(this.state.error);
    return (
      <div className="page">
        <div className="card error-boundary" role="alert">
          <h2 className="card-title">
            <TriangleAlert size={18} aria-hidden /> Algo falló en {this.props.name}
          </h2>
          <p>
            La pantalla tuvo un error, pero el resto de la app sigue funcionando y tus datos no se tocaron. Pulsa «Reintentar»; si vuelve a pasar, el detalle ya quedó guardado en el registro de la app (carpeta <code>logs</code> de tus datos).
          </p>
          <p className="muted error-boundary-detail">{message}</p>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            <RotateCcw size={15} aria-hidden /> Reintentar
          </button>
        </div>
      </div>
    );
  }
}
