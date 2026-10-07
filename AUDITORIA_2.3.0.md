# Auditoría técnica — MiAula 2.3.0

## Base analizada
La revisión parte de **MiAula 2.2.2 CETIS Admin**. El rediseño 2.3.0 no reconstruye el producto: conserva HTML, IDs, lógica JavaScript, IndexedDB, exportaciones y flujos existentes.

## Archivos funcionales
- `index.html`: vistas, formularios, navegación, modales y controles.
- `app.js`: lógica de UI, asistencia, actividades, calificaciones, cuaderno, parciales, proyecto/examen, ruleta, equipos, extras, Excel y respaldo.
- `db.js`: persistencia IndexedDB y normalización/migración compatible.
- `xlsx-lite.js`: lectura/escritura de archivos Excel.
- `styles-legacy.css`: layout y reglas heredadas preservadas por compatibilidad.
- `styles.css`: nueva capa visual MiAula Dark.
- `sw.js`: PWA, caché y actualización.
- `manifest.webmanifest`: metadatos de instalación.
- `assets/`: logo e iconos PWA.

## Persistencia
- Base IndexedDB: `MiAulaMobileDB`
- Versión DB: `3`
- Stores: `groups`, `students`, `attendance`, `activities`, `grades`, `instruments`, `evaluations`, `gradingSchemes`, `studentComponents`, `extraPoints`, `meta`.
- `localStorage`: solo preferencias de interfaz (`miaula:lastView`, `miaula:activeGroup`). No almacena calificaciones ni asistencia.
- Formato de respaldo: `MiAulaMobileBackup`, `schemaVersion: 4`.

## Funciones existentes identificadas
- Grupos: alta, edición, archivo, alumnos, baja/reactivación y orden alfabético.
- Excel: importación de listas, exportación de libreta y exportación integral.
- Asistencia: P/F/R/J, fecha, horas múltiples y estadísticas históricas.
- Actividades: creación, fecha editable, calificación, máximo diario en días hábiles y eliminación controlada.
- Cuaderno: matriz del grupo, filtros, buscador, Vista Alumno, edición rápida, autoguardado, Excel y presentación.
- Puntos extra: buenos/malos, ruleta, edición manual, consumo en actividades e historial.
- Evaluación: porcentajes, validación 100%, Valores/Actitudes, Proyecto/Examen y cálculo final.
- Proyecto: banco de rúbricas/listas de cotejo y evaluaciones reutilizables.
- Examen: captura directa 0–10 usando el porcentaje del componente principal.
- Parciales: configurables, cierre y conservación histórica de instrumentos.
- Dinámicas: ruleta, selección sin repetición, pantalla completa, equipos 2/3 y solo presentes.
- Seguridad: respaldo/restauración local.
- PWA: funcionamiento offline y actualización mediante Service Worker.

## Dependencias críticas
1. `index.html` conserva IDs usados directamente por `app.js`; no deben renombrarse sin modificar la lógica.
2. `app.js` depende de `MiAulaDB` (`db.js`) y del escritor XLSX (`xlsx-lite.js`).
3. Los cálculos de cuaderno dependen de actividades, grades, gradingSchemes, studentComponents, evaluations y extraPoints.
4. Cierre de parcial cambia el espacio de trabajo activo, pero los registros históricos permanecen.
5. Restore reemplaza los stores actuales; por eso el respaldo previo sigue siendo una acción crítica.

## Riesgos de pérdida de datos
- Cambiar `DB_NAME`, `DB_VERSION` o keyPath/stores sin migración.
- Limpiar “datos del sitio” en Chrome/Android.
- Renombrar campos persistidos sin normalización.
- Restaurar un respaldo equivocado (la restauración reemplaza la información local).
- Borrar actividades/alumnos mediante funciones de eliminación definitiva en lugar de baja/archivo.

## Decisiones de 2.3.0
- `db.js` se conserva **sin cambios**.
- No se cambian stores, claves, keyPath ni formato de respaldo.
- No se cambian IDs funcionales del DOM.
- Se preserva `styles-legacy.css` como capa de layout y se agrega un sistema visual nuevo encima.
- Service Worker usa nueva caché `miaula-mobile-2.3.0`, HTML network-first y recursos versionados.
- Al activar una nueva versión solo se eliminan cachés anteriores de MiAula; no cachés ajenas del mismo dominio.
