'use client';

import dynamic from 'next/dynamic';
import { use } from 'react';

const FeatureDetailView = dynamic(
    () => import('@/components/feature-detail/FeatureDetailView').then((m) => m.FeatureDetailView),
    { ssr: false },
);

interface PageProps {
    params: Promise<{ id: string }>;
}

export default function FeatureDetailPage({ params }: PageProps) {
    const { id } = use(params);
    return <FeatureDetailView featureId={id} />;
}
