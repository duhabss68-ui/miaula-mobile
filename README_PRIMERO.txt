MIAULA MOBILE 0.1 — PRIMERA VERSIÓN ANDROID / PWA

OBJETIVO
Esta versión ya NO usa Python ni necesita tener la laptop encendida.
Los datos se guardan en la propia tablet mediante IndexedDB.

QUÉ INCLUYE
- Grupos y alumnos.
- Importación de listas .xlsx directamente en la tablet.
- Asistencia P/F/R/J.
- Actividades y calificaciones.
- Trabajos y Proyectos con peso.
- Rúbricas y listas de cotejo.
- Evaluación individual o por equipo.
- Trimestres 1, 2 y 3.
- Trabajos / Proyectos / Valores / Actitudes.
- Exportación de concentrado .xlsx.
- Respaldo y restauración .json.
- Funcionamiento offline después de instalar.

IMPORTANTE: PARA INSTALARLA COMO APP
Una PWA debe abrirse una primera vez desde una dirección HTTPS.
Los archivos de esta carpeta son la aplicación completa, pero todavía necesitan
publicarse una sola vez en un hosting estático (por ejemplo GitHub Pages).
Después, en Android/Chrome:
  1. Abrir la dirección de MiAula Mobile.
  2. Menú de Chrome (tres puntos).
  3. Instalar aplicación / Agregar a pantalla principal.
  4. Abrir MiAula desde su icono.

Tras instalarla, el núcleo de la aplicación queda almacenado para funcionar offline.
La laptop ya no es el servidor.

MIGRAR DATOS DESDE MIAULA 2.4.1
Dentro de tools ejecuta EXPORTAR_DATOS_A_MOVIL.bat en la computadora.
Selecciona el archivo data\aula_agil.db de MiAula 2.4.1.
Se generará MiAula_Migracion.json.
Copia ese archivo a la tablet y en MiAula Mobile entra a:
  Más > Restaurar / migrar respaldo

RESPALDOS
Haz un respaldo .json con frecuencia. Los datos de esta versión viven en la tablet;
si Android borra los datos del sitio/app y no tienes respaldo, se perderían.

ESTADO
Versión 0.1 para prueba real. No incluye todavía sincronización en la nube ni APK nativo.
