# Mettre en place la transcription et le résumé

[← Retour au README](../README.md)

Le bot n'embarque aucun modèle : il appelle des serveurs que vous faites tourner sur vos machines (un PC avec GPU de préférence). La transcription est indispensable au compte rendu ; le résumé est facultatif.

## 1. Transcription : Vibe

Sur le PC GPU, télécharger `vibe-server` (releases `server-v*` de [thewh1teagle/vibe](https://github.com/thewh1teagle/vibe/releases)) et un modèle (`vibe-server pull <url>`, par exemple `ggml-large-v3-turbo.bin`), puis lancer :

```
vibe-server serve C:\models\ggml-large-v3-turbo.bin --host 0.0.0.0 --port 8080 --exit-with-parent false
```

Pour qu'il démarre avec Windows, en faire un service, avec NSSM par exemple. Vibe n'a **ni authentification ni TLS** : l'exposer uniquement sur le LAN ou Tailscale. Vérifier depuis le serveur : `curl http://pc-main.tailnet:8080/ready`.

**Secours** (facultatif) : un serveur compatible OpenAI sur une autre machine, ajouté après Vibe dans la liste :

- speaches / faster-whisper : type « compatible OpenAI », URL `http://hôte:8000/v1` ;
- serveur HTTP de **whisper.cpp** (`whisper-server`), lancé avec `--inference-path /v1/audio/transcriptions` : type « compatible OpenAI », URL `http://hôte:port/v1`, modèle au choix (celui chargé par le serveur est utilisé). Il n'a pas de `/v1/models` : le bot vérifie sa santé sur `/health`. Il ne traite qu'une requête à la fois.

Le protocole Wyoming (Home Assistant) n'est pas pris en charge : le bot ne parle qu'HTTP.

## 2. Déclarer les serveurs de transcription

`/config` → Transcription. **Seuls les propriétaires du bot peuvent modifier la liste** : le propriétaire de l'application Discord, plus la liste `owners` du YAML. Les administrateurs des serveurs peuvent consulter et tester. Avec `ai.allowedHosts` (ou la variable `AI_ALLOWED_HOSTS`), le bot n'appelle que les hôtes autorisés (par exemple `*.tailnet.ts.net`, `192.168.1.0/24`), et il ne suit jamais une redirection.

- **Ajouter** un serveur, jusqu'à 4, avec un formulaire : nom, type Vibe ou compatible OpenAI, URL, modèle, clé d'API.
- **Gérer chaque serveur** avec ses boutons : ✏️ Modifier · ⬆️ Monter · ⏸️ Désactiver / ▶️ Activer · 🧪 Tester · 🗑️ Supprimer (avec confirmation). L'ordre de la liste est l'ordre de bascule.
- **Tester** : un vrai essai (santé, puis transcription d'une seconde de silence), avec la latence affichée sous le serveur. Un test est aussi lancé automatiquement après chaque ajout ou modification.
- **Clés d'API** : stockées en base, jamais réaffichées. En modification, laisser le champ vide conserve la clé, « - » la supprime.
- Tant qu'aucun serveur n'est ajouté ici, la section `transcription.backends` du YAML s'applique.

## 3. Résumé

`/config` → Résumé. Comme pour la transcription, une **liste de serveurs par ordre de priorité** (5 au plus) : si le premier échoue (éteint, occupé, erreur, modèle absent), le suivant prend le relais pour la même passe, et les passes suivantes repartent du serveur qui a répondu.

- Le propriétaire du bot ajoute un serveur compatible OpenAI (LM Studio `http://hôte:1234/v1`, Ollama `http://hôte:11434/v1` ou LiteLLM), choisit son modèle dans la liste proposée, puis peut le monter, le désactiver, le tester ou le supprimer.
- Les administrateurs peuvent tester et désactiver le résumé.
- **Réflexion du modèle** (qwen3 et autres modèles « à raisonnement ») : réglable par serveur, **désactivée par défaut**. Désactivée, le bot ajoute `/no_think` à ses consignes : le modèle répond directement, bien plus vite, pour un résumé de qualité équivalente.
- La trace du compte rendu nomme le serveur qui a répondu.
- Sans serveur dans la liste, le bloc `llm` du YAML (ou les variables `LLM_BASE_URL`, `LLM_MODEL`) s'applique.

Côté machine : **LM Studio** (Context Length 16384 ; GPU Offload au maximum ; moteur CUDA pour une carte NVIDIA, Vulkan pour AMD/Intel) ou **Ollama** avec un modèle de résumé, par exemple `ollama pull qwen3:14b`. Avec 16 Go de VRAM partagés avec Whisper, garder un `keep_alive` court côté Ollama et `--unload-timeout` côté Vibe.

## Glossaire du serveur

`/config` → 📚 **Glossaire** (membres ayant « Gérer le serveur ») : les termes propres au serveur (jeux, projets, sigles) et leur définition, pour que le modèle de résumé comprenne de quoi on parle et ne fasse pas de contresens.

- **➕ Ajouter** un terme : le terme, ses **autres écritures** facultatives (« ramstrat, rame strat » : la transcription n'écrit pas toujours un terme de la même façon) et une définition courte et factuelle (300 caractères au plus). Le modèle la reprend telle quelle.
- **📥 Importer** plusieurs termes d'un coup, une ligne par terme : `terme (variante, variante) : définition`. Un terme déjà présent est mis à jour (casse et accents ignorés), les lignes illisibles sont signalées par leur numéro. **📤 Exporter** donne le fichier au même format, à retoucher puis réimporter.
- Jusqu'à **100 termes** par serveur ; un terme choisi dans la liste se modifie ou se supprime (avec confirmation).
- **Ce qui est envoyé** : à chaque passe du résumé, seules les définitions des termes (ou de leurs variantes) **cités dans le morceau** de transcription, les plus cités d'abord, dans la limite d'environ 600 tokens : un grand glossaire ne prend pas la place de la transcription. Les termes seuls (sans définition) complètent aussi le vocabulaire envoyé à Whisper, en dernier.
- **Transcription jointe** : dans le fichier de transcription du compte rendu (et sa copie dans le stockage), les variantes d'écriture sont remplacées par le terme (mots entiers, casse ignorée). Le texte brut de Whisper reste en base ; le fichier est refait à chaque publication.
- Modifier le glossaire pendant un résumé en plusieurs passes le fait repartir de zéro à la reprise suivante.

## 4. LiteLLM (facultatif)

LiteLLM répartit les appels entre plusieurs machines. Copier [config/litellm.example.yaml](../config/litellm.example.yaml) sur l'hôte (`/srv/meeting-bot/litellm.yaml`), puis ajouter `COMPOSE_PROFILES=litellm` et `LITELLM_MASTER_KEY` dans les variables de la stack. Sans LiteLLM, il suffit de régler le serveur dans `/config` → Résumé.

Le bot n'a pas besoin de la clé maîtresse, et ne la reçoit plus par défaut : créer une clé virtuelle limitée au modèle de résumé et la donner au bot dans `LLM_API_KEY` :

```bash
curl -s http://<hôte-litellm>:4000/key/generate -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'content-type: application/json' -d '{"models": ["summary"], "key_alias": "meeting-recorder"}'
```

Les clés virtuelles demandent une base de données côté LiteLLM (`DATABASE_URL` dans sa configuration) ; sans elle, mettre la clé maîtresse dans `LLM_API_KEY` (en connaissance de cause : elle permet d'administrer LiteLLM).
