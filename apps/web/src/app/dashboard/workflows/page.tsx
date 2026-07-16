import Workflows from "./Workflows";
import styles from "./workflows.module.css";

export default function WorkflowsPage() {
  return (
    <div>
      <span className={styles.eyebrow}>Automatización</span>
      <h1 className={styles.title}>
        Workflows y <span className="serif">seguimientos</span>
      </h1>
      <p className={styles.lead}>
        Diseña el árbol de mensajes: el primer contacto cuando entra un lead y los
        seguimientos automáticos, con esperas, ramas por respuesta o estado, y
        variables. Cuando el lead responde, la IA toma el relevo.
      </p>
      <Workflows />
    </div>
  );
}
