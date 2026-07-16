import Tags from "./Tags";
import styles from "./tags.module.css";

export default function TagsPage() {
  return (
    <div>
      <span className={styles.eyebrow}>Gestión</span>
      <h1 className={styles.title}>
        Etiquetas <span className="serif">automáticas</span>
      </h1>
      <p className={styles.lead}>
        Define las etiquetas de tu negocio y su criterio. La IA analiza cada
        conversación a fondo y aplica las que correspondan (p.ej. &quot;Llamada
        agendada&quot; o &quot;Perdido&quot;). Puedes ajustarlas a mano en cada
        chat; la IA respeta lo que edites.
      </p>
      <Tags />
    </div>
  );
}
