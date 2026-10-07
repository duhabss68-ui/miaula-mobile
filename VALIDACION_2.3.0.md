# Validación — MiAula Dark 2.3.0

## Persistencia
- DB name: `MiAulaMobileDB` — sin cambio.
- DB version: `3` — sin cambio.
- `db.js` comparado byte a byte con 2.2.2 — debe permanecer idéntico.
- Stores y respaldo sin cambios.

## Funciones críticas revisadas por código
- Iniciar clase / Modo clase.
- Asistencia multihora.
- Actividades, calificaciones y edición de fecha.
- Cuaderno + Vista Alumno + minibuscador + máximo diario.
- Proyecto / Examen.
- Porcentajes y validación 100%.
- Respaldo y restauración.
- Exportar Excel total y por cuaderno.
- Ruleta + extras + pantalla completa.
- Crear equipos.
- Rúbricas y listas de cotejo.
- Cierre de parcial.

## Actualización PWA
- Caché: `miaula-mobile-2.3.0`.
- Navegación: network-first con fallback offline.
- Recursos: versionados con `?v=2.3.0`.
- `styles-legacy.css` se incluye en precache.
- Activación elimina únicamente cachés anteriores con prefijo `miaula-mobile-`.
