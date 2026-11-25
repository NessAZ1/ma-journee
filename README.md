# Ma Journée

Le GPS du quotidien : notez vos rendez-vous et vos tâches, l'app trouve les lieux, choisit le meilleur ordre, calcule les trajets et vous envoie sur Google Maps.

## Fonctionnalités

- Ajout rapide en langage courant (« dentiste à 9h, pharmacie, colis avant 12h »)
- Modèles en un tap (Travail, Courses, Pharmacie, Sport…) et lieux favoris
- Planning optimisé : rendez-vous fixes, tâches flexibles, priorités, heures limites, répétitions
- Recherche du lieu le plus proche (OpenStreetMap), bouton « Y aller » vers Google Maps
- Vue jour et semaine, carte de l'itinéraire
- Import d'agendas .ics (Teams / Outlook, Google Agenda, Doctolib), export vers Google Agenda, Outlook ou fichier .ics
- Rappels « Il est temps de partir », partage de la journée, mode sombre, installable sur téléphone

Les données restent sur l'appareil de l'utilisateur.

## Version Pro (facultative)

Avec le serveur Pro (dossier `organisateur-api`, à installer une fois sur Cloudflare), l'app gagne :

- un **assistant IA (Claude)** qui comprend n'importe quelle phrase et propose des actions, que l'utilisateur confirme ;
- des **rappels « Il est temps de partir » même app fermée** : le serveur ne reçoit que des horaires.

L'adresse du serveur se règle dans `config.js`. Tant qu'elle est vide, l'app fonctionne en mode simple et le bloc Pro n'apparaît pas.

## Lancer en local

```
node serve.js
```

puis ouvrir http://localhost:5173
