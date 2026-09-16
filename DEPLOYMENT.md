# Migrazione MiniStage al backend

## Stato della proposta

Progetto destinazione: `mini-stage-levi`, Firestore Standard `(default)`, `eur3`.
La configurazione web è quella fornita dal proprietario. Nessun accesso diretto
ai documenti Firestore è consentito ai browser; le regole mantengono il blocco
già presente nella console. Le famiglie non devono creare un account.

Questa proposta è da pubblicare e verificare prima di unire il frontend in `main`.
Il nuovo endpoint non è ancora stato distribuito. Il vecchio database non è
stato modificato, migrato o eliminato.

## Componenti

- `bookingApi`: disponibilità senza dati personali, creazione transazionale,
  recupero con codice casuale a 96 bit ed email, annullamento con scorrimento,
  recupero del codice via email, accesso commissione e scanner con scadenza.
- `sendBookingNotification`: coda Firestore con generazione PDF, pagina per
  autorizzazione all'uscita autonoma e invio al precedente endpoint Apps Script.
  Una risposta positiva del provider non garantisce la consegna nella casella.
- `maintainBookings`: controllo ogni 15 minuti di scorrimenti e chiusura delle
  presenze a fine attività, indipendente dalle pagine aperte nel browser.
- Il calendario del 6 e 20 novembre 2026 viene creato una sola volta sul nuovo
  database. Il percorso dei documenti resta compatibile con le schermate attuali.
- Il browser condivide le richieste di stato e aggiorna la disponibilità ogni
  15 secondi; il server controlla sempre la capienza reale quando si prenota.

## Pubblicazione

1. Il proprietario deve abilitare il piano **Blaze** sul progetto: Firebase
   richiede questo piano per distribuire Cloud Functions. Non è stato attivato
   alcun piano a pagamento durante la preparazione.
   Fonte: https://firebase.google.com/docs/functions/get-started
2. Abilitare Google in Authentication e autorizzare il dominio
   `orientamento-primolevi.github.io` per l'accesso della commissione.
   Il backend ammette solo il token Google verificato di
   `orientamento@leviseregno.edu.it`. La vecchia password pubblica non concede
   più autorizzazioni. L'accesso anonimo è già attivo per compatibilità con il
   caricamento degli script esistenti, ma non concede accesso ai dati.
3. Da una macchina con Node.js 22 e npm:

   ```sh
   cd functions
   npm install
   npm test
   cd ..
   npx -y firebase-tools@latest login
   npx -y firebase-tools@latest deploy --only functions,firestore:rules --project mini-stage-levi
   ```

4. Verificare che l'endpoint restituito sia
   `https://europe-west1-mini-stage-levi.cloudfunctions.net/bookingApi`.
   Se diverso, aggiornare `ministage-backend-client.js`.
5. Completare le verifiche online sotto elencate. Solo dopo pubblicare il
   frontend aggiornato su GitHub Pages unendo la proposta.

`maxInstances` limita il parallelismo delle funzioni ma **non è un tetto di
spesa**. Impostare gli avvisi di budget della scuola prima dell'apertura.

## Verifiche eseguite

- 23 test automatici locali: validazione, duplicati, idempotenza, autorizzazione
  al recupero/annullamento, slot disattivati/scaduti, errori di accesso, dati
  privati assenti dallo stato pubblico e sintassi JavaScript.
- Simulazione di 40 richieste su 25 posti: 25 confermate, 15 in lista d'attesa.
  Il repository in memoria serializza le transazioni per questa prova; non è
  un test di carico contro Firestore reale.
- Avvio/caricamento delle tre Cloud Functions con le dipendenze installate.
- Generazione server del PDF con autorizzazione all'uscita autonoma.
- Browser locale: creazione, ricevuta, recupero con codice/email e annullamento.
  Dati fittizi in memoria, nessun messaggio inviato.

## Verifiche necessarie prima del merge

- Emulatori Firebase o ambiente di staging: concorrenza Firestore, negazione
  accesso diretto e rifiuto delle operazioni amministrative senza token valido.
- Login Google della commissione, logout e scadenza/revoca delle sessioni scanner.
- Consegna reale di conferma, recupero, scorrimento e attestato tramite Apps
  Script; usare un indirizzo di collaudo autorizzato, non famiglie reali.
- Flusso completo della console docente, comprese le eliminazioni definitive:
  sono riservate alla commissione. Uno slot con prenotazioni non può essere
  eliminato; va prima disattivato. Non sono state eseguite eliminazioni reali.
- I comandi storici di promemoria manuale e PDF della console vanno verificati
  online; non sono stati collaudati con l'identità della commissione.
- La chiusura automatica passa in uscita gli studenti marcati presenti;
  l'effettiva consegna dell'attestato resta dipendente dal provider email.

## Vecchio database

Il vecchio progetto `sistema-prenotazione-levi` non è accessibile con l'account
inizialmente collegato. Prima di qualsiasi eliminazione occorre verificare se
contiene prenotazioni da conservare/esportare, collaudare la nuova installazione
e confermare il database esatto da eliminare. La sostituzione della configurazione
del sito non cancella il vecchio progetto né i suoi dati.
