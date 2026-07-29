use std::io;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::mpsc;

use super::diagnostics::DiagnosticsState;

pub const OUTBOUND_QUEUE_CAPACITY: usize = 256;
pub const INBOUND_QUEUE_CAPACITY: usize = 256;
const MAX_PROTOCOL_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_STDERR_LINE_BYTES: usize = 16 * 1024;

#[derive(Debug)]
pub enum OutboundFrame {
    Message(Value),
    Shutdown,
}

#[derive(Debug)]
pub enum InboundFrame {
    Message(Value),
    Malformed(String),
    Oversized,
    TransportError(String),
    Eof,
}

pub fn spawn_writer(
    stdin: ChildStdin,
    mut receiver: mpsc::Receiver<OutboundFrame>,
    diagnostics: Arc<DiagnosticsState>,
    inbound: mpsc::Sender<InboundFrame>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(frame) = receiver.recv().await {
            diagnostics.queue_decrement();
            match frame {
                OutboundFrame::Message(message) => {
                    let mut encoded = match serde_json::to_vec(&message) {
                        Ok(encoded) => encoded,
                        Err(error) => {
                            let _ = inbound
                                .send(InboundFrame::TransportError(format!(
                                    "Unable to encode Codex request: {error}"
                                )))
                                .await;
                            break;
                        }
                    };
                    encoded.push(b'\n');
                    if let Err(error) = stdin.write_all(&encoded).await {
                        let _ = inbound
                            .send(InboundFrame::TransportError(format!(
                                "Unable to write to Codex app-server: {error}"
                            )))
                            .await;
                        break;
                    }
                    if let Err(error) = stdin.flush().await {
                        let _ = inbound
                            .send(InboundFrame::TransportError(format!(
                                "Unable to flush Codex app-server input: {error}"
                            )))
                            .await;
                        break;
                    }
                }
                OutboundFrame::Shutdown => break,
            }
        }
        let _ = stdin.shutdown().await;
    })
}

pub fn spawn_stdout_reader(
    stdout: ChildStdout,
    sender: mpsc::Sender<InboundFrame>,
    diagnostics: Arc<DiagnosticsState>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_bounded_line(&mut reader, MAX_PROTOCOL_LINE_BYTES).await {
                Ok(Some(BoundedLine::Line(line))) => {
                    let frame = match serde_json::from_slice::<Value>(&line) {
                        Ok(message) => InboundFrame::Message(message),
                        Err(error) => InboundFrame::Malformed(format!(
                            "Malformed Codex JSONL message: {error}"
                        )),
                    };
                    if !send_inbound(&sender, &diagnostics, frame).await {
                        break;
                    }
                }
                Ok(Some(BoundedLine::Oversized)) => {
                    if !send_inbound(&sender, &diagnostics, InboundFrame::Oversized).await {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = send_inbound(&sender, &diagnostics, InboundFrame::Eof).await;
                    break;
                }
                Err(error) => {
                    let _ = send_inbound(
                        &sender,
                        &diagnostics,
                        InboundFrame::TransportError(format!(
                            "Unable to read Codex app-server output: {error}"
                        )),
                    )
                    .await;
                    break;
                }
            }
        }
    })
}

async fn send_inbound(
    sender: &mpsc::Sender<InboundFrame>,
    diagnostics: &DiagnosticsState,
    frame: InboundFrame,
) -> bool {
    diagnostics.queue_increment();
    if sender.send(frame).await.is_err() {
        diagnostics.queue_decrement();
        false
    } else {
        true
    }
}

pub fn spawn_stderr_reader(
    stderr: ChildStderr,
    diagnostics: Arc<DiagnosticsState>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        loop {
            match read_bounded_line(&mut reader, MAX_STDERR_LINE_BYTES).await {
                Ok(Some(BoundedLine::Line(line))) => {
                    diagnostics.push_stderr(&String::from_utf8_lossy(&line));
                }
                Ok(Some(BoundedLine::Oversized)) => {
                    diagnostics.push_stderr("[truncated oversized Codex stderr line]");
                }
                Ok(None) => break,
                Err(error) => {
                    diagnostics
                        .push_protocol_error(&format!("Unable to read Codex stderr: {error}"));
                    break;
                }
            }
        }
    })
}

enum BoundedLine {
    Line(Vec<u8>),
    Oversized,
}

async fn read_bounded_line<R>(reader: &mut R, maximum: usize) -> io::Result<Option<BoundedLine>>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if line.is_empty() && !oversized {
                return Ok(None);
            }
            return Ok(Some(if oversized {
                BoundedLine::Oversized
            } else {
                BoundedLine::Line(line)
            }));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        if !oversized {
            let content_end = newline.unwrap_or(available.len());
            if line.len().saturating_add(content_end) > maximum {
                oversized = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..content_end]);
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(if oversized {
                BoundedLine::Oversized
            } else {
                BoundedLine::Line(line)
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::BufReader;

    use super::{read_bounded_line, BoundedLine};

    #[tokio::test]
    async fn reads_jsonl_without_the_newline() {
        let source = b"{\"id\":1}\n{\"id\":2}\r\n".as_slice();
        let mut reader = BufReader::new(source);
        match read_bounded_line(&mut reader, 100).await.unwrap().unwrap() {
            BoundedLine::Line(line) => assert_eq!(line, b"{\"id\":1}"),
            BoundedLine::Oversized => panic!("line should fit"),
        }
        match read_bounded_line(&mut reader, 100).await.unwrap().unwrap() {
            BoundedLine::Line(line) => assert_eq!(line, b"{\"id\":2}"),
            BoundedLine::Oversized => panic!("line should fit"),
        }
    }

    #[tokio::test]
    async fn isolates_oversized_lines_and_resumes_framing() {
        let source = b"123456\n{}\n".as_slice();
        let mut reader = BufReader::new(source);
        assert!(matches!(
            read_bounded_line(&mut reader, 4).await.unwrap(),
            Some(BoundedLine::Oversized)
        ));
        match read_bounded_line(&mut reader, 4).await.unwrap().unwrap() {
            BoundedLine::Line(line) => assert_eq!(line, b"{}"),
            BoundedLine::Oversized => panic!("second line should fit"),
        }
    }
}
