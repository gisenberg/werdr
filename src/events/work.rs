//! Finite background-worker accounting, not process-tree or effect ownership.
//!
//! Registration precedes spawn. Dropping an unstarted registration is safe;
//! dropping started work without explicit completion leaves sticky uncertainty.
//! A later idle-looking queue must not erase a cancelled or panicking worker.

use super::admission::Admission;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug)]
pub(crate) enum BackgroundWork {
    GitRefresh,
    PluginCommand,
    WorktreeAdd,
    WorktreeRemove,
    WorktreeRead,
    StatusCommand,
    UpdateCheck,
    ManifestUpdate,
    RestoreTimer,
}

#[derive(Default)]
pub(super) struct WorkLedger {
    epoch: Arc<()>,
    active: HashMap<usize, BackgroundWork>,
    uncertain: Option<BackgroundWork>,
}

struct TrackedWork {
    admission: Arc<Mutex<Admission>>,
    identity: Arc<()>,
    kind: BackgroundWork,
    started: bool,
    complete: bool,
}

pub(crate) struct WorkRegistration(TrackedWork);
pub(crate) struct ActiveWork(TrackedWork);

impl WorkRegistration {
    pub(super) fn new(admission: Arc<Mutex<Admission>>, kind: BackgroundWork) -> Self {
        let identity = Arc::new(());
        {
            // Maintain bookkeeping after poison without rehabilitating the
            // lock: capture and publication still reject its poisoned state.
            let mut state = admission.lock().unwrap_or_else(|err| err.into_inner());
            state.work.epoch = Arc::new(());
            state
                .work
                .active
                .insert(Arc::as_ptr(&identity) as usize, kind);
        }
        Self(TrackedWork {
            admission,
            identity,
            kind,
            started: false,
            complete: false,
        })
    }

    pub(crate) fn start(mut self) -> ActiveWork {
        self.0.started = true;
        ActiveWork(self.0)
    }
}

impl ActiveWork {
    /// Only after the owned operation and its result publication have finished.
    /// Abort/drop and process-kill requests are not completion acknowledgements.
    pub(crate) fn complete(mut self) {
        self.0.complete = true;
    }
}

impl Drop for TrackedWork {
    fn drop(&mut self) {
        let mut state = self.admission.lock().unwrap_or_else(|err| err.into_inner());
        state
            .work
            .active
            .remove(&(Arc::as_ptr(&self.identity) as usize));
        if self.started && !self.complete {
            state.work.uncertain.get_or_insert(self.kind);
        }
    }
}

#[cfg(any(unix, test))]
pub(crate) struct WorkCheckpoint {
    admission: Arc<Mutex<Admission>>,
    epoch: Arc<()>,
}

#[cfg(any(unix, test))]
impl WorkCheckpoint {
    pub(super) fn new(admission: &Arc<Mutex<Admission>>) -> Result<Self, String> {
        let state = admission
            .lock()
            .map_err(|_| "event admission lock poisoned")?;
        if let Some(failure) = state.failure {
            return Err(failure.into());
        }
        Self::check_idle(&state.work)?;
        Ok(Self {
            admission: admission.clone(),
            epoch: state.work.epoch.clone(),
        })
    }

    fn check_idle(work: &WorkLedger) -> Result<(), String> {
        if let Some(kind) = work.uncertain {
            return Err(format!("background work completion is uncertain: {kind:?}"));
        }
        if !work.active.is_empty() {
            return Err("background work is still active".into());
        }
        Ok(())
    }

    pub(super) fn validate(&self, admission: &Arc<Mutex<Admission>>) -> Result<(), String> {
        if !Arc::ptr_eq(&self.admission, admission) {
            return Err("background work checkpoint belongs to another inbox".into());
        }
        let state = self
            .admission
            .lock()
            .map_err(|_| "event admission lock poisoned")?;
        if let Some(failure) = state.failure {
            return Err(failure.into());
        }
        Self::check_idle(&state.work)?;
        if !Arc::ptr_eq(&self.epoch, &state.work.epoch) {
            return Err("background work started during capture".into());
        }
        Ok(())
    }
}
