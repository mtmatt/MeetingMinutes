import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Play, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { MeetingDetail, Slide } from "../api/types";
import { useI18n } from "../i18n";
import { clock } from "../lib/format";
import { usePlayer } from "../lib/player";
import { Modal, useConfirm } from "./Modal";
import { useToast } from "./Toast";

export const slideUrl = (meetingId: string, slideId: string) => `/api/meetings/${encodeURIComponent(meetingId)}/slides/${encodeURIComponent(slideId)}`;

/** Which slides go before each transcript paragraph (by its start time), and which come after the last. */
export function slidesByBlock(slides: Slide[], starts: number[]): { before: Slide[][]; after: Slide[] } {
  const before: Slide[][] = starts.map(() => []);
  const after: Slide[] = [];
  for (const s of slides) {
    // The first paragraph that starts after the slide appeared; a slide shown mid-paragraph goes before the next one.
    let i = starts.findIndex((t) => t >= s.at - 0.5);
    if (i < 0) after.push(s);
    else before[i]!.push(s);
  }
  return { before, after };
}

/** A slide in the transcript, where it appeared: click to see it large. */
export function SlideCard({ meeting, slide, index, onOpen }: { meeting: MeetingDetail; slide: Slide; index: number; onOpen: (index: number) => void }) {
  const { t } = useI18n();
  const { seek } = usePlayer();
  const long = (meeting.durationSec ?? 0) >= 3600;
  return (
    <figure className="slide-card">
      <button type="button" className="slide-card-img" onClick={() => onOpen(index)} aria-label={t("slides.open", { n: index + 1 })}>
        <img src={slideUrl(meeting.id, slide.id)} alt={t("slides.thumbAlt", { t: clock(slide.at, long) })} width={slide.width} height={slide.height} loading="lazy" decoding="async" />
      </button>
      <figcaption>
        <button type="button" className="block-time mono" onClick={() => seek(slide.at, true)}>
          {clock(slide.at, long)}
        </button>
        <span className="faint">{t("slides.cardLabel", { n: index + 1, total: meeting.slides?.length ?? 0 })}</span>
      </figcaption>
    </figure>
  );
}

/** A slide at full size, with the ones before and after it, a jump to when it appeared, and deleting it. */
export function SlideViewer({ meeting, index, onIndex, onClose }: { meeting: MeetingDetail; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const { t } = useI18n();
  const { seek } = usePlayer();
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const slides = meeting.slides ?? [];
  const [busy, setBusy] = useState(false);
  const slide = slides[index];
  const long = (meeting.durationSec ?? 0) >= 3600;

  // Arrow keys page through the slides here, instead of skipping the recording.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const next = index + (e.key === "ArrowRight" ? 1 : -1);
      if (next >= 0 && next < slides.length) onIndex(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, slides.length, onIndex]);

  // The neighbours load while this one is looked at.
  useEffect(() => {
    for (const n of [slides[index - 1], slides[index + 1]]) if (n) new Image().src = slideUrl(meeting.id, n.id);
  }, [index, slides, meeting.id]);

  if (!slide) return null;

  const remove = async () => {
    const ok = await confirm({ title: t("slides.deleteTitle"), body: t("slides.deleteBody"), confirmLabel: t("common.delete"), danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteSlide(meeting.id, slide.id);
      await qc.invalidateQueries({ queryKey: ["meeting", meeting.id] });
      toast.show(t("slides.deleted"));
      if (slides.length <= 1) onClose();
      else if (index >= slides.length - 1) onIndex(index - 1);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={t("slides.viewerTitle", { n: index + 1, total: slides.length })}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost btn-danger" onClick={() => void remove()} disabled={busy}>
            <Trash2 /> {t("common.delete")}
          </button>
          <span className="modal-foot-spacer" />
          <button className="btn" onClick={() => onIndex(index - 1)} disabled={index === 0} aria-label={t("slides.previous")}>
            <ChevronLeft />
          </button>
          <button className="btn" onClick={() => onIndex(index + 1)} disabled={index >= slides.length - 1} aria-label={t("slides.next")}>
            <ChevronRight />
          </button>
          <button
            className="btn btn-ink"
            onClick={() => {
              seek(slide.at, true);
              onClose();
            }}
          >
            <Play /> {t("slides.playFrom", { t: clock(slide.at, long) })}
          </button>
        </>
      }
    >
      <div className="slide-viewer">
        <img key={slide.id} src={slideUrl(meeting.id, slide.id)} alt={t("slides.thumbAlt", { t: clock(slide.at, long) })} width={slide.width} height={slide.height} />
      </div>
    </Modal>
  );
}
